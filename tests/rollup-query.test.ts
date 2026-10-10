import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';
import { nowIso } from '../src/worker/db/dialect.ts';
import { listWithStatus } from '../src/worker/repository/monitors.ts';
import type { DatabaseAdapter } from '../src/worker/db/types.ts';

/**
 * The 90-day uptime query.
 *
 * What was wrong
 * --------------
 * `listWithStatus` computed `uptime_90d` by scanning the raw `checks` table
 * across the whole window, and consulted `daily_status` only when that scan
 * came back empty. The rollup is one row per monitor per day -- roughly 90 rows
 * -- while the raw scan has to walk every check still retained, which at a
 * 5-minute interval over the 7-day retention window is ~2,000 rows *per
 * monitor*. The comment above the rollup query even described the correct
 * intent; the code did the opposite of it.
 *
 * Why it matters in D1 specifically
 * ---------------------------------
 * D1 bills *rows read*, not bytes and not query count. A single wide scan of an
 * unindexed window is what exhausts the daily allowance, and it exhausts it
 * silently -- the request still returns 200. The dashboard calls this function
 * twice per page view, so the cost is paid twice.
 *
 * What these tests pin down
 * -------------------------
 * That the rollup is consulted first, that the raw scan is skipped entirely
 * once it can answer, and that it is still available as a fallback for a fresh
 * instance whose nightly job has not run yet. The query counter is what turns
 * "prefer the cheap source" into something a test can actually fail on.
 */

let dir: string;
let raw: LibsqlAdapter;
let counted: DatabaseAdapter;

/** Every statement that reaches the database, tagged by caller. */
let log: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-rollup-'));
  raw = await LibsqlAdapter.create('sqlite', { url: `file:${join(dir, 'rollup.db')}` });
  await raw.migrate();

  // A thin proxy that records SQL without changing behaviour. Wrapping the real
  // adapter keeps the test honest: the repository still does its actual work.
  counted = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: string, params?: readonly unknown[]) => {
          log.push(sql.replace(/\s+/g, ' ').trim());
          return target.query(sql, params);
        };
      }
      if (prop === 'execute') {
        return async (sql: string, params?: readonly unknown[]) => {
          log.push(sql.replace(/\s+/g, ' ').trim());
          return target.execute(sql, params);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DatabaseAdapter;
});

after(async () => {
  await raw.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

async function addMonitor(name: string) {
  const now = nowIso();
  const id = crypto.randomUUID();
  await raw.execute(
    `INSERT INTO monitors (id, name, url, method, active, interval_seconds, timeout_ms,
       retries, max_response_bytes, follow_redirects, created_at, updated_at)
     VALUES (?, ?, 'https://example.com', 'GET', 1, 300, 5000, 0, 65536, 1, ?, ?)`,
    [id, name, now, now],
  );
  return id;
}

async function addCheck(monitorId: string, status: 'up' | 'down', daysAgo: number) {
  await raw.execute(
    `INSERT INTO checks (id, monitor_id, status, response_time_ms, status_code, checked_at)
     VALUES (?, ?, ?, 100, 200, ?)`,
    [crypto.randomUUID(), monitorId, status, new Date(Date.now() - daysAgo * 86_400_000).toISOString()],
  );
}

async function addRollup(monitorId: string, date: string, total: number, up: number) {
  await raw.execute(
    `INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks,
       degraded_checks, downtime_seconds, avg_response_time_ms)
     VALUES (?, ?, ?, ?, 0, 0, 0, 100)`,
    [monitorId, date, total, up],
  );
}

/**
 * How many aggregate scans of raw history ran.
 *
 * Both the 24-hour and the 90-day window use the same `SELECT monitor_id,
 * COUNT(*) ... FROM checks GROUP BY monitor_id` shape, differing only in their
 * bound parameter. An earlier version of this helper asked "did any such query
 * run", which is always true because the 24-hour one legitimately always runs,
 * and reported a fix as broken. Counting is what distinguishes them: two
 * before the change, one after.
 */
const rawHistoryScans = () =>
  log.filter(
    (sql) => sql.startsWith('SELECT monitor_id, COUNT(*) AS total') && sql.includes('FROM checks'),
  ).length;

describe('90-day uptime — rollup before raw history', () => {
  test('skips the raw-history scan once the rollup can answer', async () => {
    const id = await addMonitor('Rollup covered');
    // 90 days of rollup: 90 checks, all passing.
    for (let day = 0; day < 90; day += 1) {
      const date = new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10);
      await addRollup(id, date, 1, 1);
    }
    // And a handful of raw checks that disagree, so a raw scan would be visible.
    for (let i = 0; i < 5; i += 1) await addCheck(id, 'down', 1);

    log = [];
    const monitors = await listWithStatus(counted, { limit: 10 });
    const monitor = monitors[0];

    assert.ok(monitor, 'the monitor just created must be in the list');
    assert.equal(monitor.uptime_90d, 100, 'uptime must come from the rollup');
    assert.equal(
      rawHistoryScans(),
      1,
      'only the 24-hour raw scan should remain once the rollup covers the window',
    );
  });

  test('still falls back to raw history before the first nightly job', async () => {
    const id = await addMonitor('No rollup yet');
    for (let i = 0; i < 8; i += 1) await addCheck(id, 'up', i % 3);
    for (let i = 0; i < 2; i += 1) await addCheck(id, 'down', i);

    log = [];
    const monitors = await listWithStatus(counted, { limit: 10 });
    const target = monitors.find((m) => m.id === id);

    assert.ok(target, 'the new monitor should appear in the list');
    assert.equal(
      rawHistoryScans(),
      2,
      'a fresh instance has no rollup, so both the 24h and 90d raw scans are expected',
    );
    assert.ok(target.uptime_90d !== null, 'the fallback still produces a figure');
    assert.ok(
      target.uptime_90d! > 0 && target.uptime_90d! < 100,
      `expected a partial figure from 8 up / 2 down, got ${target.uptime_90d}`,
    );
  });

  test('24h uptime keeps reading raw checks', async () => {
    // The short window must NOT be moved onto the rollup: daily rollups are
    // written nightly, so they cannot answer "in the last 24 hours" on a
    // running instance.
    const id = await addMonitor('Today');
    await addRollup(id, new Date().toISOString().slice(0, 10), 100, 100);
    for (let i = 0; i < 6; i += 1) await addCheck(id, 'up', 0);
    for (let i = 0; i < 4; i += 1) await addCheck(id, 'down', 0);

    log = [];
    const monitors = await listWithStatus(counted, { limit: 10 });
    const target = monitors.find((m) => m.id === id);

    assert.ok(target);
    assert.equal(target.uptime_24h, 60, '24h comes from raw checks, not the nightly rollup');
    assert.equal(
      log.some((sql) => sql.includes('AS total') && sql.includes('FROM checks') && sql.includes('checked_at >= ?')),
      true,
      'the 24-hour raw query is expected and should remain',
    );
  });
});
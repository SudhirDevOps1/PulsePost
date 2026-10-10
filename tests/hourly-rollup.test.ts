import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';
import { nowIso } from '../src/worker/db/dialect.ts';
import { runSweep, type SweepOptions } from '../src/worker/checkers/sweep.ts';
import type { DatabaseAdapter } from '../src/worker/db/types.ts';

/**
 * The hourly rollup.
 *
 * THE COST THIS PROTECTS
 * ----------------------
 * `daily_status` is the cheap answer to every long-window uptime question: one
 * row per monitor per day. `listWithStatus` reads it first and only falls back
 * to scanning the whole retained `checks` table for monitors it cannot find a
 * rollup row for.
 *
 * On a mature instance that fallback almost never runs. On a *fresh* deployment
 * it ran for every monitor on every single list call until the first nightly
 * job -- up to twenty-four hours of full-history scans, once per dashboard poll,
 * for a dashboard that honestly displays an em dash the whole time. Measured on
 * the live instance: 5M rows read in a day against a 5M free-tier allowance,
 * 39k queries, ~128 rows each. The whole allowance, spent on the first day, to
 * show a dash.
 *
 * The rollup therefore runs once an hour rather than once a night, gated on the
 * UTC minute being 0. `runSweep` takes an injected clock so that gate is
 * testable at all.
 *
 * WHAT IS PINNED
 * --------------
 * 1. A sweep landing on minute 0 produces a `daily_status` row. Without the
 *    hourly call this table stays empty and every assertion here fails.
 * 2. Running it again does *not* double the totals. The upsert assigns a
 *    recomputed aggregate rather than adding to the stored one; a comment in
 *    `aggregateDaily` claimed the opposite and would have stopped anyone from
 *    running this more than once a day.
 * 3. A sweep on any other minute leaves the rollup alone.
 *
 * (1) is the regression that matters. (2) exists because "is it idempotent" is
 * the question that decides whether the fix is safe at all, and an incorrect
 * comment nearly answered it wrongly.
 */

let dir: string;
let db: DatabaseAdapter;

const OPTIONS: SweepOptions = {
  checksPerRun: 20,
  rawCheckRetentionDays: 7,
  dailyStatusRetentionDays: 365,
  // Far from any plausible UTC hour, so the nightly job cannot be what creates
  // the row under test.
  maintenanceHourUtc: 23,
  appName: 'PulsePost',
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-rollup-hourly-'));
  db = await LibsqlAdapter.create('sqlite', { url: `file:${join(dir, 'hourly.db')}` });
  await db.migrate();
});

after(async () => {
  await db.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

async function seedMonitor(): Promise<string> {
  const now = nowIso();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO monitors (id, name, url, method, active, interval_seconds, timeout_ms,
       retries, max_response_bytes, follow_redirects, created_at, updated_at)
     VALUES (?, ?, 'https://example.com', 'GET', 0, 300, 5000, 0, 65536, 1, ?, ?)`,
    [id, 'rolled', now, now],
  );
  // Paused (active = 0) so the sweep performs no network checks. The rollup
  // reads historical rows, not the live monitor, which is what isolates it.
  return id;
}

async function seedChecks(monitorId: string, count: number, up: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await db.execute(
      `INSERT INTO checks (id, monitor_id, status, response_time_ms, status_code, checked_at)
       VALUES (?, ?, ?, 100, 200, ?)`,
      [crypto.randomUUID(), monitorId, i < up ? 'up' : 'down', new Date().toISOString()],
    );
  }
}

async function rollupFor(monitorId: string) {
  const result = await db.query<{ total_checks: number; up_checks: number }>(
    `SELECT total_checks, up_checks FROM daily_status WHERE monitor_id = ?`,
    [monitorId],
  );
  return result.rows[0] ?? null;
}

/** A UTC instant whose minute component is the given value. */
function atMinute(minute: number): number {
  const d = new Date();
  d.setUTCMinutes(minute, 0, 0);
  return d.getTime();
}

describe('hourly rollup', () => {
  test('a sweep on minute 0 writes daily_status, without the nightly job', async () => {
    const monitorId = await seedMonitor();
    await seedChecks(monitorId, 10, 8);

    await runSweep(db, OPTIONS, atMinute(0));

    const row = await rollupFor(monitorId);
    assert.ok(row, 'daily_status row missing: the fallback raw scan would run on every list call');
    assert.equal(row.total_checks, 10);
    assert.equal(row.up_checks, 8);
  });

  test('running it again does not double the totals', async () => {
    const monitorId = await seedMonitor();
    await seedChecks(monitorId, 10, 8);

    await runSweep(db, OPTIONS, atMinute(0));
    const first = await rollupFor(monitorId);

    await runSweep(db, OPTIONS, atMinute(0));
    const second = await rollupFor(monitorId);

    assert.ok(first && second);
    assert.equal(
      second.total_checks,
      first.total_checks,
      'totals doubled: the upsert is adding to the stored aggregate instead of replacing it',
    );
    assert.equal(second.up_checks, first.up_checks);
    assert.equal(second.total_checks, 10);
  });

  test('a sweep on any other minute leaves the rollup alone', async () => {
    const monitorId = await seedMonitor();
    await seedChecks(monitorId, 10, 8);

    await runSweep(db, OPTIONS, atMinute(37));

    const row = await rollupFor(monitorId);
    assert.equal(row, null, 'rolled up outside minute 0, so this runs every minute again');
  });
});

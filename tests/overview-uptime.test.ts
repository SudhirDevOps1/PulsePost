import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app } from '../src/worker/index.ts';
import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';
import { nowIso } from '../src/worker/db/dialect.ts';

/**
 * Regression cover for the dashboard overview's weighted uptime.
 *
 * The bug
 * -------
 * `overall.uptime_24h` averaged `uptime_24h` across *every* monitor, including
 * paused ones. A paused monitor reports 0, because it is not being checked and
 * has no successful checks to divide by. So one healthy monitor plus one
 * deliberately switched-off monitor reported 50% -- while the status word in
 * the tile immediately above it read "Operational". Two tiles describing the
 * same fleet, disagreeing, on the same screen.
 *
 * The live instance showed exactly this: `demo` at 100% and a paused
 * `demo 2` at 0%, averaging to 50.00%.
 *
 * Why this file exists separately from api.test.ts
 * -----------------------------------------------
 * That suite's fixtures never write a single check row, so every monitor's
 * `uptime_24h` is `null` and `average([null, null])` is `null` either way. A
 * test written against it passes whether the bug is present or not -- it looks
 * like coverage and is not. This suite seeds real check history so the
 * assertion can actually fail.
 */

let dir: string;
let dbPath: string;
let db: LibsqlAdapter;

const ASSETS: Fetcher = {
  fetch: async () => new Response('/* index.html */', { headers: { 'content-type': 'text/html' } }),
} as unknown as Fetcher;

function env() {
  return {
    DB_PROVIDER: 'sqlite',
    DATABASE_URL: `file:${dbPath}`,
    ENVIRONMENT: 'development',
    APP_NAME: 'Upimetest',
    AUTH_MODE: 'password',
    ASSETS,
    ALLOW_PRIVATE_TARGETS: false,
    AUTH_RATE_LIMIT: 1000,
    API_RATE_LIMIT: 1000,
    RATE_WINDOW_SECONDS: 60,
  };
}

async function call(path: string, cookie = '') {
  const response = await app.fetch(
    new Request(`https://pulsepost.test${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
    env() as never,
  );
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : undefined };
}

interface Overview {
  total: number;
  up: number;
  down: number;
  degraded: number;
  paused: number;
  uptime_24h: number | null;
  uptime_90d: number | null;
}

/** Insert a monitor plus `upChecks` passing and `downChecks` failing rows. */
async function seedMonitor(name: string, options: { active: boolean; upChecks: number; downChecks: number }) {
  const now = nowIso();
  const id = crypto.randomUUID();

  await db.execute(
    `INSERT INTO monitors (id, name, url, method, active, interval_seconds, timeout_ms,
       retries, max_response_bytes, follow_redirects, created_at, updated_at)
     VALUES (?, ?, 'https://example.com', 'GET', ?, 300, 5000, 0, 65536, 1, ?, ?)`,
    [id, name, options.active, now, now],
  );

  // Spread the rows over the last hour so they land inside the 24h window the
  // overview reads, with the failures newest -- a monitor that was up and then
  // broke, which is what a real outage looks like.
  const rows: Array<[string, string, string, number, number, string]> = [];
  for (let i = 0; i < options.upChecks; i += 1) {
    const at = new Date(Date.now() - (options.upChecks - i) * 60_000).toISOString();
    rows.push([crypto.randomUUID(), id, 'up', 120, 200, at]);
  }
  for (let i = 0; i < options.downChecks; i += 1) {
    const at = new Date(Date.now() - i * 60_000).toISOString();
    rows.push([crypto.randomUUID(), id, 'down', 0, 500, at]);
  }
  for (const row of rows) {
    await db.execute(
      `INSERT INTO checks (id, monitor_id, status, response_time_ms, status_code, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row,
    );
  }
  return id;
}

/**
 * Record the sweep's materialised status for a monitor.
 *
 * The sweep writes one `alert_states` row per monitor on every check, so this
 * is what the overview reads to count up/down/degraded.
 */
async function seedAlertState(monitorId: string, status: 'up' | 'down' | 'degraded') {
  await db.execute(
    `INSERT INTO alert_states (monitor_id, current_status, previous_status, down_since, notify_count, updated_at)
     VALUES (?, ?, NULL, NULL, 0, ?)`,
    [monitorId, status, nowIso()],
  );
}

let cookie = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-uptime-'));
  dbPath = join(dir, 'uptime.db');
  db = await LibsqlAdapter.create('sqlite', { url: `file:${dbPath}` });
  await db.migrate();

  // Create the first admin through the app's own setup endpoint rather than
  // writing a user row by hand: it produces a real PBKDF2 hash and, more to the
  // point, a genuine session cookie to make authenticated requests with.
  const created = await app.fetch(
    new Request('https://pulsepost.test/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct-horse-Battery9!',
        name: 'Owner',
      }),
    }),
    env() as never,
  );
  assert.equal(created.status, 201, 'setup should create the first admin');
  cookie = (created.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  assert.ok(cookie, 'setup should hand back a session cookie');
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

describe('overview — weighted uptime', () => {
  test('excludes paused monitors from the uptime average', async () => {
    // One healthy monitor at 100%, one switched off at 0%.
    await seedMonitor('Healthy', { active: true, upChecks: 10, downChecks: 0 });
    await seedMonitor('Switched off', { active: false, upChecks: 0, downChecks: 0 });

    const { response, json } = await call('/api/monitors/overview', cookie);
    assert.equal(response.status, 200);
    const overview = json.overview as Overview;

    assert.equal(overview.total, 2);
    assert.equal(overview.paused, 1);

    // The healthy monitor is at 100%. Including the paused one would report
    // 50% and contradict the "Operational" word right above it.
    assert.equal(
      overview.uptime_24h,
      100,
      'paused monitors must not pull the weighted uptime below the active ones',
    );
  });

  test('still reflects genuine downtime on active monitors', async () => {
    // A monitor that really was down must drag the number down -- the fix
    // removes paused monitors from the denominator, not failures.
    await seedMonitor('Half dead', { active: true, upChecks: 5, downChecks: 5 });

    const { json } = await call('/api/monitors/overview', cookie);
    const overview = json.overview as Overview;

    assert.ok(overview.uptime_24h !== null, 'active monitors still provide a basis');
    assert.ok(
      overview.uptime_24h! < 100 && overview.uptime_24h! > 0,
      `expected a partial uptime from a half-failing monitor, got ${overview.uptime_24h}`,
    );
  });

  test('counts status from alert_states, not from check history', async () => {
    // The optimisation: the overview used to materialise every monitor and join
    // the latest check per monitor just to count them. It now reads the one-row
    // -per-monitor `alert_states` table that the sweep already maintains.
    //
    // These monitors get an alert state but *no* check rows at all. An
    // implementation that still joined check history would report zero of
    // everything, which is precisely the work being removed.
    //
    // Assertions are on the delta rather than absolute counts, because earlier
    // cases in this file share the same database.
    const before = (await call('/api/monitors/overview', cookie)).json.overview as Overview;

    const healthy = await seedMonitor('Alpha healthy', { active: true, upChecks: 0, downChecks: 0 });
    const broken = await seedMonitor('Beta broken', { active: true, upChecks: 0, downChecks: 0 });
    const slow = await seedMonitor('Gamma slow', { active: true, upChecks: 0, downChecks: 0 });
    const off = await seedMonitor('Delta paused', { active: false, upChecks: 0, downChecks: 0 });

    await seedAlertState(healthy, 'up');
    await seedAlertState(broken, 'down');
    await seedAlertState(slow, 'degraded');
    await seedAlertState(off, 'down'); // stale status on a paused monitor

    const { response, json } = await call('/api/monitors/overview', cookie);
    assert.equal(response.status, 200);
    const after = json.overview as Overview;

    assert.equal(after.total - before.total, 4, 'four monitors added');
    assert.equal(after.up - before.up, 1, 'one healthy active monitor');
    assert.equal(after.down - before.down, 1, 'one broken active monitor');
    assert.equal(after.degraded - before.degraded, 1, 'one degraded active monitor');
    assert.equal(
      after.paused - before.paused,
      1,
      "a paused monitor's status must never be counted, however stale it is",
    );
  });

  test('counts a never-checked monitor in total but not in any status bucket', async () => {
    // No alert_states row and no checks: unknown, not up and not down.
    await seedMonitor('Omega fresh', { active: true, upChecks: 0, downChecks: 0 });

    const { json } = await call('/api/monitors/overview', cookie);
    const overview = json.overview as Overview;

    const buckets = overview.up + overview.down + overview.degraded;
    assert.ok(
      overview.total > buckets,
      'a monitor that has never been checked belongs in total but in no status bucket',
    );
  });

  test('reports null, not zero, when nothing is active', async () => {
    await db.execute(`UPDATE monitors SET active = 0`);
    const { json } = await call('/api/monitors/overview', cookie);
    const overview = json.overview as Overview;

    assert.equal(overview.paused, overview.total);
    assert.equal(
      overview.uptime_24h,
      null,
      'no active monitors means no basis for an average, not a confident 0%',
    );
  });
});
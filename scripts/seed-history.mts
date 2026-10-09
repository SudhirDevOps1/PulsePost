#!/usr/bin/env node
/**
 * Backfill synthetic check history into the local database.
 *
 * The cron sweep only writes one row per monitor per minute, so a fresh local
 * install has no history to render. This inserts a realistic 7-day trace:
 * mostly-healthy latency with jitter, occasional degradation, and one monitor
 * with a genuine outage window — which is exactly the set of shapes the charts,
 * uptime bars and edge map need in order to be judged.
 *
 * Writes straight to the database via the libSQL adapter (the API has no
 * history-write endpoint by design) but reuses the project's own adapter so the
 * SQL is validated against the real schema.
 */
import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL ?? 'file:./.wrangler/state/v3/d1/miniflare-D1DatabaseObject/pulsepost.sqlite';

const COLOS = [
  ['LHR', 'London', 'GB', 'Europe', 51.51, -0.13],
  ['FRA', 'Frankfurt', 'DE', 'Europe', 50.11, 8.68],
  ['AMS', 'Amsterdam', 'NL', 'Europe', 52.37, 4.9],
  ['SJC', 'San Jose', 'US', 'Americas', 37.34, -121.89],
  ['IAD', 'Ashburn', 'US', 'Americas', 39.04, -77.49],
  ['SYD', 'Sydney', 'AU', 'Asia Pacific', -33.87, 151.21],
  ['NRT', 'Tokyo', 'JP', 'Asia Pacific', 35.68, 139.69],
  ['BOM', 'Mumbai', 'IN', 'Asia Pacific', 19.08, 72.88],
  ['GRU', 'Sao Paulo', 'BR', 'Americas', -23.55, -46.63],
  ['JNB', 'Johannesburg', 'ZA', 'Africa', -26.2, 28.05],
];

const MINUTES_BACK = 7 * 24 * 60;
const STEP_MS = 5 * 60 * 1000;

function jitter(base, spread) {
  return Math.max(8, Math.round(base + (Math.random() - 0.5) * spread));
}

async function main() {
  const db = await LibsqlAdapter.create('sqlite', { url });
  await db.connect();
  await db.migrate();

  const monitors = await db.query<{ id: string; name: string }>('SELECT id, name FROM monitors');
  if (monitors.rows.length === 0) {
    console.log('No monitors found — run `node scripts/seed-demo.mjs` first.');
    return;
  }

  const now = Date.now();
  const statements = [];
  let inserted = 0;

  for (const monitor of monitors.rows) {
    const name = monitor.name;
    const isSlow = name.includes('CDN');
    const isDown = name.includes('Billing');

    // Baseline latency per monitor, plus a per-colo multiplier so the map has
    // a believable geographic spread rather than uniform dots.
    const base = isSlow ? 900 : name.includes('Auth') ? 60 : 180;

    for (let step = MINUTES_BACK; step >= 0; step -= 5) {
      const at = new Date(now - step * 60_000);
      const iso = at.toISOString();

      // Outage window for the "down" monitor: the last 5 hours.
      const inOutage = isDown && step <= 300 && step > 20;

      let status = 'up';
      let ms = jitter(base, base * 0.4);
      let code = 200;

      if (inOutage) {
        status = 'down';
        ms = null;
        code = 503;
      } else if (isSlow && Math.random() < 0.18) {
        status = 'degraded';
        ms = jitter(1600, 700);
      } else if (Math.random() < 0.012) {
        status = 'down';
        ms = null;
        code = 500;
      }

      // Each check is attributed to one of the colos.
      const colo = COLOS[Math.floor(Math.random() * COLOS.length)]!;
      const coloFactor = 1 + (Math.abs(colo[4]) % 7) / 20;
      const finalMs = ms === null ? null : Math.round(ms * coloFactor);

      statements.push({
        sql: `INSERT INTO checks (id, monitor_id, status, response_time_ms, status_code, colo, region, checked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [randomUUID(), monitor.id, status, finalMs, code, colo[0], colo[3], iso],
      });
      inserted += 1;
    }
  }

  // Chunked inserts: SQLite caps bound parameters per statement.
  const COLUMNS = 8;
  const CHUNK = 100;

  for (let offset = 0; offset < statements.length; offset += CHUNK) {
    const slice = statements.slice(offset, offset + CHUNK);
    const group = `(${new Array(COLUMNS).fill('?').join(', ')})`;
    const params = slice.flatMap((statement) => statement.params);
    await db.execute(
      `INSERT INTO checks (id, monitor_id, status, response_time_ms, status_code, colo, region, checked_at)
       VALUES ${slice.map(() => group).join(', ')}`,
      params,
    );
  }

  console.log(`Inserted ${inserted} check rows across ${monitors.rows.length} monitor(s).`);
  // Populate `daily_status` as well.
  //
  // In production this table is filled by the nightly aggregation job, which
  // only runs during MAINTENANCE_HOUR_UTC. Without it the 90-day uptime bars
  // render empty, so a fresh demo would look broken for reasons that have
  // nothing to do with the UI.
  const dates = await db.query<{ date: string }>(
    'SELECT DISTINCT substr(checked_at, 1, 10) AS date FROM checks ORDER BY date ASC',
  );

  let rollups = 0;

  for (const { date } of dates.rows) {
    for (const monitor of monitors.rows) {
      const stats = await db.query<{
        total: number; up: number; down: number; degraded: number;
        sum_rt: number; max_rt: number; with_rt: number;
      }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up,
                SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
                SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
                SUM(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms ELSE 0 END) AS sum_rt,
                MAX(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms ELSE 0 END) AS max_rt,
                COUNT(response_time_ms) AS with_rt
           FROM checks
          WHERE monitor_id = ? AND substr(checked_at, 1, 10) = ?`,
        [monitor.id, date],
      );

      const row = stats.rows[0];
      if (!row || Number(row.total) === 0) continue;

      const down = Number(row.down) || 0;
      const withRt = Number(row.with_rt) || 0;
      const avg = withRt > 0 ? Math.round((Number(row.sum_rt) || 0) / withRt) : null;

      await db.execute(
        `INSERT INTO daily_status (
           monitor_id, date, total_checks, up_checks, down_checks, degraded_checks,
           downtime_seconds, avg_response_time_ms, max_response_time_ms, p95_response_time_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (monitor_id, date) DO UPDATE SET
           total_checks = excluded.total_checks,
           up_checks = excluded.up_checks,
           down_checks = excluded.down_checks,
           avg_response_time_ms = excluded.avg_response_time_ms,
           max_response_time_ms = excluded.max_response_time_ms`,
        [
          monitor.id, date,
          Number(row.total), Number(row.up) || 0, down, Number(row.degraded) || 0,
          down * 300, avg, Number(row.max_rt) || null,
          avg === null ? null : Math.round(avg * 1.8),
        ],
      );
      rollups += 1;
    }
  }

  console.log(`Wrote ${rollups} daily rollup row(s).`);

  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

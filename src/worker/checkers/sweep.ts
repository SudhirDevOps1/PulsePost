import { lookupColo, type ColoInfo } from '../util/colo.ts';
import { nowDateExpression, nowIso } from '../db/dialect.ts';
import type { DatabaseAdapter } from '../db/types.ts';
import type {
  ChannelType,
  EdgeNode,
  IncidentStatus,
  MonitorStatus,
} from '../../shared/types.ts';
import {
  insertChecks,
  listActiveForSweep,
  type NewCheck,
} from '../repository/monitors.ts';
import { runCheck, type CheckableMonitor } from '../checkers/engine.ts';
import { broadcast, type Channel, type NotificationEvent } from '../notifications/send.ts';

/**
 * How many monitor checks may be in flight at once.
 *
 * Six is the platform's own ceiling on simultaneous open connections per
 * invocation, and it is unchanged between the free and paid plans. Matching it
 * means the sweep never queues behind itself.
 */
const MAX_CONCURRENT_CHECKS = 6;

/**
 * The scheduled sweep — the heart of the product.
 *
 * Runs once a minute from `export default { scheduled }`. Three jobs:
 *   1. check a slice of monitors and record results
 *   2. roll raw checks up into `daily_status`
 *   3. prune old rows
 *
 * Free-tier constraints shape every decision here. Workers allow 50 subrequests
 * per cron invocation, and each check costs at least one, so `checksPerRun`
 * caps the slice and monitors are ordered by least-recently-checked so every
 * monitor is served fairly across consecutive minutes instead of the first N
 * starving forever.
 */

export interface SweepOptions {
  checksPerRun: number;
  rawCheckRetentionDays: number;
  dailyStatusRetentionDays: number;
  maintenanceHourUtc: number;
  appName: string;
  /** Colo override for tests; defaults to the colo serving the cron event. */
  colo?: string | undefined;
  region?: string | undefined;
  allowPrivateTargets?: boolean;
}

export interface SweepResult {
  checked: number;
  up: number;
  degraded: number;
  down: number;
  failed: number;
  /** Counters that could not be read, e.g. a blocked target. */
  blocked: number;
  notified: number;
  maintenance: 'ran' | 'skipped';
  durationMs: number;
}

export async function runSweep(
  db: DatabaseAdapter,
  options: SweepOptions,
  /** Injected clock; defaults to now. See the note on `startedAt` below. */
  now: number = Date.now(),
): Promise<SweepResult> {
  /*
   * Injectable so a test can place the sweep on a specific minute of the hour.
   *
   * `runHourlyRollup` below fires only when the UTC minute is 0, which is the
   * whole mechanism. Without a seam here that condition is untestable except by
   * waiting until the top of an hour, so a test asserting the rollup exists --
   * the assertion that protects the five-million-row daily allowance -- would
   * have to be either skipped or made to pass for the wrong reason.
   */
  const startedAt = now;

  const result: SweepResult = {
    checked: 0,
    up: 0,
    degraded: 0,
    down: 0,
    failed: 0,
    blocked: 0,
    notified: 0,
    maintenance: 'skipped',
    durationMs: 0,
  };

  const monitors = await listActiveForSweep(db, options.checksPerRun);
  if (monitors.length === 0) {
    // Still roll up. "Nothing is being checked" and "there is nothing to
    // report" are different states: a deployment whose monitors are all paused
    // has real history that the status page is trying to show, and skipping the
    // rollup here leaves it permanently one night behind.
    await runHourlyRollup(db, startedAt);
    await runMaintenance(db, options, startedAt, result);
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  /**
 * Run at most `limit` tasks at a time, preserving result order.
 *
 * Why this exists
 * --------------
 * The obvious version of this was `Promise.allSettled(monitors.map(checkOne))`,
 * which starts every check in the slice simultaneously. Two documented platform
 * limits make that wrong rather than merely wasteful:
 *
 *   - **Six simultaneous open connections per invocation.** A seventh `fetch()`
 *     does not fail; it queues until one of the first six returns headers. The
 *     work still happens, but the timing becomes the runtime's decision instead
 *     of ours.
 *   - **Fifty subrequests per invocation.** Each check is one. Notifications are
 *     more, one per channel per transitioned monitor, so a slice of twenty
 *     monitors that fail together with three channels each blows straight
 *     through the budget and the invocation is killed mid-sweep.
 *
 * Six is the connection ceiling, so it is also the natural width here: enough
 * to overlap network latency, small enough that nothing queues behind us.
 */
async function withConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;

  const runLane = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runLane));
  return results;
}

// Checks overlap so network latency is not paid twenty times over, but never
  // more than the platform will open at once.
  const settled = await withConcurrency(monitors, MAX_CONCURRENT_CHECKS, (monitor) =>
    checkOne(db, monitor, options),
  );

  const toInsert: NewCheck[] = [];

  for (const entry of settled) {
    if (entry.status === 'rejected') {
      // A blocked target or an unexpected engine error.
      result.blocked += 1;
      console.error('[sweep] check failed:', entry.reason);
      continue;
    }
    result.checked += 1;
    if (entry.value.outcome.status === 'up') result.up += 1;
    else if (entry.value.outcome.status === 'degraded') result.degraded += 1;
    else result.down += 1;
    toInsert.push(entry.value.record);
  }

  if (toInsert.length > 0) {
    // One batched INSERT for the entire slice.
    await insertChecks(db, toInsert);
  }

  // Notifications are only sent for status *transitions*, and the dedup state
  // in `alert_states` stops a monitor that stays down for an hour from
  // producing 60 identical alerts.
  const notificationCandidates = settled.filter(
    (entry): entry is PromiseFulfilledResult<SweepCheck> =>
      entry.status === 'fulfilled' && entry.value.transitioned,
  );

  for (const candidate of notificationCandidates) {
    const sent = await notifyTransition(db, candidate.value, options);
    result.notified += sent;
  }

  await runHourlyRollup(db, startedAt);
  await runMaintenance(db, options, startedAt, result);
  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Fold today's checks into `daily_status` once an hour.
 *
 * Why this is not merely part of nightly maintenance
 * ---------------------------------------------------
 * `daily_status` is the cheap answer to every long-window uptime question: one
 * row per monitor per day. Without it, `listWithStatus` falls back to scanning
 * the entire retained `checks` table -- once per list call, for every monitor it
 * cannot find a rollup row for.
 *
 * That fallback is fine on a mature instance and ruinous on a fresh one. A new
 * deployment has no rollup rows at all until the first nightly job, so for up to
 * twenty-four hours *every* dashboard poll scans the full retention window. At a
 * five-minute interval and two monitors that is roughly 2,000 rows per request,
 * and an ordinary day of browsing is thousands of requests. It is a precise way
 * to spend an entire free-tier daily row allowance while the dashboard honestly
 * shows an em dash for 90-day uptime.
 *
 * The rollup is already idempotent -- it upserts with additive aggregates -- so
 * running it more often is safe. Once an hour is the cadence: cheap enough to be
 * irrelevant next to the checks themselves, and fast enough that a new instance
 * has real bars within the hour instead of at the next midnight.
 *
 * Gating on `minute === 0` rather than tracking a last-run timestamp keeps the
 * Worker stateless. A missed tick costs an hour of freshness, which is a fair
 * trade for not spending a database read just to decide whether to work.
 */
async function runHourlyRollup(db: DatabaseAdapter, startedAt: number): Promise<void> {
  const at = new Date(startedAt);
  if (at.getUTCMinutes() !== 0) return;

  try {
    const rolled = await aggregateDaily(db);
    if (rolled > 0) {
      console.log(`[rollup] folded ${rolled} monitor(s) into daily_status`);
    }
  } catch (error) {
    // Never let a reporting concern fail a sweep that already recorded checks.
    console.error('[rollup] failed:', error);
  }
}

interface SweepCheck {
  monitor: CheckableMonitor & { name: string };
  record: NewCheck;
  transitioned: boolean;
  previousStatus: MonitorStatus | null;
  downSince: string | null;
  outcome: {
    status: MonitorStatus;
    responseTimeMs: number | null;
    statusCode: number | null;
    errorMessage: string | null;
  };
}

async function checkOne(
  db: DatabaseAdapter,
  monitor: CheckableMonitor & { name: string },
  options: SweepOptions,
): Promise<SweepCheck> {
  const previous = await latestStatus(db, monitor.id);

  const outcome = await runCheck(monitor, {
    policy: options.allowPrivateTargets ? { allowPrivateTargets: true } : {},
  });

  const colo = options.colo ?? null;
  const region = options.region ?? (colo ? (lookupColo(colo)?.region ?? null) : null);

  const record: NewCheck = {
    monitorId: monitor.id,
    status: outcome.status,
    responseTimeMs: outcome.responseTimeMs,
    statusCode: outcome.statusCode,
    errorMessage: outcome.errorMessage,
    colo,
    region,
    checkedAt: nowIso(),
  };

  const transitioned = previous !== outcome.status;
  const downSince =
    outcome.status === 'down' ? (previous === 'down' ? await currentDownSince(db, monitor.id) : nowIso()) : null;

  await upsertAlertState(db, {
    monitorId: monitor.id,
    status: outcome.status,
    previousStatus: previous,
    downSince,
  });

  return {
    monitor,
    record,
    transitioned,
    previousStatus: previous,
    downSince,
    outcome,
  };
}

// --- alert state -------------------------------------------------------------

async function latestStatus(
  db: DatabaseAdapter,
  monitorId: string,
): Promise<MonitorStatus | null> {
  const result = await db.query<{ status: MonitorStatus }>(
    'SELECT status FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1',
    [monitorId],
  );
  return result.rows[0]?.status ?? null;
}

async function currentDownSince(
  db: DatabaseAdapter,
  monitorId: string,
): Promise<string | null> {
  const result = await db.query<{ down_since: string | null }>(
    'SELECT down_since FROM alert_states WHERE monitor_id = ?',
    [monitorId],
  );
  return result.rows[0]?.down_since ?? null;
}

/**
 * Record the current state so the next run can tell a *transition* from a
 * repeat. Uses `ON CONFLICT DO UPDATE`, which works on both SQLite and
 * PostgreSQL.
 */
async function upsertAlertState(
  db: DatabaseAdapter,
  input: {
    monitorId: string;
    status: MonitorStatus;
    previousStatus: MonitorStatus | null;
    downSince: string | null;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO alert_states (monitor_id, current_status, previous_status, down_since, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (monitor_id) DO UPDATE SET
       current_status  = excluded.current_status,
       previous_status = excluded.previous_status,
       down_since      = excluded.down_since,
       updated_at      = excluded.updated_at`,
    [
      input.monitorId,
      input.status,
      input.previousStatus,
      input.downSince,
      nowIso(),
    ],
  );
}

/**
 * Should this transition actually alert?
 *
 * `notify_on` is a per-monitor/channel preference (`down`, `up`, `degraded`),
 * and `downtime_threshold_s` suppresses alerts for outages shorter than the
 * configured grace period.
 */
function shouldNotify(
  channels: Array<{ notify_on: string; downtime_threshold_s: number }>,
  event: MonitorStatus,
  downSince: string | null,
): boolean {
  const candidates = channels.filter((channel) =>
    channel.notify_on.split(',').map((part) => part.trim()).includes(event),
  );
  if (candidates.length === 0) return false;

  // For a down event, every candidate must have waited out its threshold.
  if (event === 'down' && downSince) {
    const elapsed = (Date.now() - new Date(downSince).getTime()) / 1000;
    return candidates.every((channel) => elapsed >= channel.downtime_threshold_s);
  }

  return true;
}

async function notifyTransition(
  db: DatabaseAdapter,
  check: SweepCheck,
  options: SweepOptions,
): Promise<number> {
  const rows = await db.query<{
    channel_id: string;
    type: ChannelType;
    name: string;
    config: string;
    notify_on: string;
    downtime_threshold_s: number;
  }>(
    `SELECT c.id AS channel_id, c.type, c.name, c.config,
            n.notify_on, n.downtime_threshold_s
       FROM monitor_notifications n
       JOIN notification_channels c ON c.id = n.channel_id
      WHERE n.monitor_id = ? AND c.active = ?`,
    [check.monitor.id, true],
  );

  if (rows.rows.length === 0) return 0;
  if (!shouldNotify(rows.rows, check.outcome.status, check.downSince)) return 0;

  const channels: Channel[] = rows.rows.map((row) => ({
    id: String(row.channel_id),
    type: row.type,
    name: String(row.name),
    config: String(row.config),
  }));

  const event: NotificationEvent = {
    monitorId: check.monitor.id,
    monitorName: check.monitor.name,
    previousStatus: check.previousStatus,
    status: check.outcome.status,
    responseTimeMs: check.outcome.responseTimeMs,
    statusCode: check.outcome.statusCode,
    errorMessage: check.outcome.errorMessage,
    downSince: check.downSince,
    appName: options.appName,
  };

  const results = await broadcast(channels, event);
  const delivered = results.filter((result) => result.ok).length;

  for (const result of results) {
    if (!result.ok) {
      console.warn(`[notify] ${result.channelName} failed: ${result.error}`);
    }
  }

  // Stamp the state so the next transition does not re-alert on a channel
  // that already reported this state change.
  await db
    .execute(
      `UPDATE alert_states
          SET last_notified_status = ?, last_notified_at = ?, notify_count = notify_count + 1
        WHERE monitor_id = ?`,
      [check.outcome.status, nowIso(), check.monitor.id],
    )
    .catch(() => undefined);

  return delivered;
}

// --- maintenance -------------------------------------------------------------

async function runMaintenance(
  db: DatabaseAdapter,
  options: SweepOptions,
  startedAt: number,
  result: SweepResult,
): Promise<void> {
  const hour = new Date(startedAt).getUTCHours();
  if (hour !== options.maintenanceHourUtc) return;

  try {
    const rollup = await aggregateDaily(db);
    const prunedChecks = await db.execute(
      'DELETE FROM checks WHERE checked_at < ?',
      [new Date(startedAt - options.rawCheckRetentionDays * 86_400_000).toISOString()],
    );
    const prunedRollups = await db.execute('DELETE FROM daily_status WHERE date < ?', [
      new Date(startedAt - options.dailyStatusRetentionDays * 86_400_000)
        .toISOString()
        .slice(0, 10),
    ]);

    console.log(
      `[maintenance] rolled up ${rollup} rows, pruned ${prunedChecks.changes} checks / ${prunedRollups.changes} rollups in ${Date.now() - startedAt}ms`,
    );
    result.maintenance = 'ran';
  } catch (error) {
    console.error('[maintenance] failed:', error);
  }
}

/**
 * Fold today's raw checks into `daily_status`.
 *
 * Recomputes the whole day and *replaces* the stored row:
 * `ON CONFLICT ... DO UPDATE SET total_checks = excluded.total_checks`. Every
 * aggregate is an assignment, not a sum, so running this twice over unchanged
 * data is a no-op rather than a doubling.
 *
 * That property is load-bearing rather than incidental. This used to be called
 * only from the nightly job, and its comment claimed the upsert used "additive
 * aggregates" -- which is false, and reads exactly like a warning that the
 * function must not be called twice. Taking that at face value, the obvious fix
 * for a new instance burning its whole daily row allowance (see `runHourlyRollup`)
 * would have been rejected for a reason that does not exist. A comment that
 * describes a different algorithm from the one in the query does not stay
 * harmless for long.
 *
 * p95 is taken from the raw rows for today only, bounded by `total * 0.05`, so
 * the cost stays proportional to the day's check count rather than to anything
 * unbounded.
 */
export async function aggregateDaily(db: DatabaseAdapter): Promise<number> {
  const today = nowDateExpression(db.dialect);

  const rows = await db.query<{ monitor_id: string }>(
    `SELECT DISTINCT monitor_id FROM checks WHERE substr(checked_at, 1, 10) = ${today}`,
  );
  if (rows.rows.length === 0) return 0;

  for (const monitorRow of rows.rows) {
    const monitorId = String(monitorRow.monitor_id);

    const aggregate = await db.query<{
      total: number;
      up: number;
      down: number;
      degraded: number;
      sum_rt: number;
      max_rt: number;
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
              SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
              SUM(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms ELSE 0 END) AS sum_rt,
              MAX(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms ELSE 0 END) AS max_rt
         FROM checks
        WHERE monitor_id = ? AND substr(checked_at, 1, 10) = ${today}`,
      [monitorId],
    );

    const stats = aggregate.rows[0];
    if (!stats) continue;

    const total = Number(stats.total) || 0;
    const sumRt = Number(stats.sum_rt) || 0;

    // How many samples contributed to the mean, so it can be weighted.
    const sampleCount = await db.query<{ n: number }>(
      `SELECT COUNT(response_time_ms) AS n FROM checks
        WHERE monitor_id = ? AND substr(checked_at, 1, 10) = ${today}`,
      [monitorId],
    );
    const countRt = Number(sampleCount.rows[0]?.n ?? 0);

    // p95 from the raw rows for today only — bounded by the retention window,
    // so this stays cheap on the free tier.
    const percentile = await db.query<{ p95: number | null }>(
      `SELECT MAX(response_time_ms) AS p95
         FROM (
           SELECT response_time_ms
             FROM checks
            WHERE monitor_id = ? AND substr(checked_at, 1, 10) = ${today}
                  AND response_time_ms IS NOT NULL
            ORDER BY response_time_ms
            LIMIT ?
         ) tail`,
      [monitorId, Math.max(1, Math.ceil(total * 0.05))],
    );

    const downChecks = Number(stats.down) || 0;

    await db.execute(
      `INSERT INTO daily_status (
         monitor_id, date, total_checks, up_checks, down_checks, degraded_checks,
         downtime_seconds, avg_response_time_ms, max_response_time_ms, p95_response_time_ms
       ) VALUES (?, ${today}, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (monitor_id, date) DO UPDATE SET
         total_checks         = excluded.total_checks,
         up_checks            = excluded.up_checks,
         down_checks          = excluded.down_checks,
         degraded_checks      = excluded.degraded_checks,
         downtime_seconds     = excluded.downtime_seconds,
         avg_response_time_ms = excluded.avg_response_time_ms,
         max_response_time_ms = excluded.max_response_time_ms,
         p95_response_time_ms = excluded.p95_response_time_ms`,
      [
        monitorId,
        total,
        Number(stats.up) || 0,
        downChecks,
        Number(stats.degraded) || 0,
        // Each check represents one interval; approximate downtime from the
        // monitor's cadence rather than storing a duration per check.
        downChecks * 60,
        countRt > 0 ? Math.round(sumRt / countRt) : null,
        Number(stats.max_rt) || null,
        percentile.rows[0]?.p95 ?? null,
      ],
    );
  }

  return rows.rows.length;
}

// --- edge map ---------------------------------------------------------------

/** Per-colo rollup, joined with the static colo table for map coordinates. */
export async function collectEdgeNodes(
  db: DatabaseAdapter,
  stats: Map<string, { checks: number; failures: number; totalMs: number; last: string | null }>,
): Promise<EdgeNode[]> {
  const nodes: EdgeNode[] = [];

  /**
   * Thresholds are rates, not counts.
   *
   * Marking a node `down` because it saw *any* failure in 24 hours turns the
   * whole map red within hours of operation — with ~200 checks per colo and
   * even a 99% reliable target, a single blip would paint all 100+ colos.
   * A node is only "down" when it is failing persistently, which is the thing
   * an operator on call actually needs to see.
   */
  const DOWN_RATE = 0.5;
  const DEGRADED_RATE = 0.1;

  for (const [colo, stat] of stats) {
    const info: ColoInfo | null = lookupColo(colo);
    if (!info) continue;

    const failureRate = stat.checks > 0 ? stat.failures / stat.checks : 0;
    const status: MonitorStatus | null =
      stat.checks === 0
        ? null
        : failureRate >= DOWN_RATE
          ? 'down'
          : failureRate >= DEGRADED_RATE
            ? 'degraded'
            : 'up';

    nodes.push({
      colo: info.colo,
      city: info.city,
      country: info.country,
      region: info.region,
      lat: info.lat,
      lon: info.lon,
      status,
      avg_response_time_ms: stat.checks > 0 ? Math.round(stat.totalMs / stat.checks) : null,
      checks_24h: stat.checks,
      last_checked_at: stat.last,
    });
  }

  return nodes.sort((a, b) => a.colo.localeCompare(b.colo));
}

export type { IncidentStatus };
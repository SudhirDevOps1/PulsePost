import { Hono } from 'hono';
import { validateJson, validateQuery, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import { requireAuth } from '../middleware/context.ts';
import type { AppEnv } from '../middleware/context.ts';
import { apiRateLimit } from '../middleware/ratelimit.ts';
import { nowIso } from '../db/dialect.ts';
import type { DatabaseAdapter } from '../db/types.ts';
import * as repo from '../repository/monitors.ts';
import { runCheck } from '../checkers/engine.ts';
import { validateUrl, DEFAULT_POLICY, SsrfError } from '../checkers/ssrf.ts';
import { edgeNodeStats } from '../repository/monitors.ts';
import { collectEdgeNodes } from '../checkers/sweep.ts';
import { lookupColo, type RequestCfLike } from './helpers.ts';
import { audit } from './auth.ts';
import {
  createMonitorSchema,
  updateMonitorSchema,
  listMonitorsQuerySchema,
  idParamSchema,
  checkHistoryQuerySchema,
} from '../../shared/schemas.ts';
import type { EdgeNode, Monitor } from '../../shared/types.ts';

/**
 * Monitor CRUD, check history, and the dashboard overview.
 *
 * Every route is `requireAuth`-gated except the deliberately public status
 * routes in `status.ts`. Mutations additionally re-validate the URL through
 * the SSRF guard, because the Zod schema checks *shape* while the guard checks
 * *reachability* — and only the latter is what makes a monitor safe to store.
 */

export const monitorRoutes = new Hono<AppEnv>();

/**
 * Mean response time across every check in the last 24 hours.
 *
 * The obvious implementation — averaging each monitor's `avg_response_time_ms`
 * — reads from `daily_status`, which is a *rollup* the nightly job writes. On a
 * fresh instance that table is empty until the first night, so the dashboard's
 * "Avg latency" tile rendered a bare em-dash for up to 24 hours after setup,
 * next to a monitor card that was showing a real number from the same checks.
 * Two sources disagreeing on the same measurement is worse than either being
 * blank.
 *
 * Raw `checks` rows exist the moment the first sweep lands, and the 7-day
 * retention comfortably covers a 24-hour window. `idx_checks_time` serves this
 * as a range scan, and it costs one indexed query rather than the rollup read
 * it replaces.
 */
async function averageLatency24h(db: DatabaseAdapter): Promise<number | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await db.query<{ avg: number | null }>(
    `SELECT AVG(response_time_ms) AS avg
       FROM checks
      WHERE checked_at >= ?1 AND response_time_ms IS NOT NULL`,
    [cutoff],
  );
  const avg = row.rows[0]?.avg;
  return avg === null || avg === undefined ? null : Math.round(Number(avg));
}

monitorRoutes.use('*', apiRateLimit(), requireAuth('viewer'));

monitorRoutes.get('/', validateQuery(listMonitorsQuerySchema), async (c) => {
  const query = c.req.valid('query');

  const monitors = await repo.listWithStatus(c.get('db'), {
    groupId: query.group,
    status: query.status,
    active: query.active,
    limit: query.limit,
    includeDaily: query.include_uptime,
    includeLatency: query.include_latency,
    offset: query.offset,
    search: query.q,
    sort: query.sort,
    order: query.order,
  });

  // Echo the paging window so the client can render controls without having to
  // re-derive the server's own defaults. `has_more` is the usual trick for a
  // LIMIT/OFFSET list that would rather not pay for a COUNT(*) per keystroke.
  return c.json({
    monitors,
    limit: query.limit,
    offset: query.offset,
    has_more: monitors.length === query.limit,
  });
});

monitorRoutes.get('/overview', async (c) => {
  const db = c.get('db');
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const since90d = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

  /**
   * The overview is a summary, so it is computed as a summary.
   *
   * This used to call `listWithStatus({ limit: 500 })` -- materialising 500
   * monitor rows plus a latest-check-per-monitor join, only to count them and
   * throw them away. The dashboard fetches the monitor list separately, so
   * every page view paid for the same work twice and gained nothing from it.
   *
   * `alert_states` is the materialised current status: the sweep upserts one row
   * per monitor on *every* check, not only on transitions, so it is always
   * current. Counting from a one-row-per-monitor table replaces a join that
   * walked check history.
   *
   * A monitor that has never been checked has no `alert_states` row. The LEFT
   * JOIN keeps it in `total` while leaving it out of up/down/degraded, which is
   * exactly what the per-monitor version did with `current_status: null`.
   */
  const [counts, statuses, uptime24h, uptime90d, incidents, lastSweep] = await Promise.all([
    db.query<{ total: number; active: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN active THEN 1 ELSE 0 END) AS active
         FROM monitors`,
    ),
    db.query<{ status: string | null; n: number }>(
      `SELECT a.current_status AS status, COUNT(*) AS n
         FROM monitors m
         LEFT JOIN alert_states a ON a.monitor_id = m.id
        WHERE m.active = ?
        GROUP BY a.current_status`,
      [true],
    ),
    // Weighted across ACTIVE monitors only.
    //
    // A paused monitor reports no successful checks, so folding it in punished
    // the instance for a monitor somebody deliberately switched off: 50% uptime
    // sitting directly under the word "Operational".
    windowUptime(db, since24h),
    // 90 days comes from the nightly rollup -- about 90 rows per monitor instead
    // of walking raw check history. The raw window is never consulted here.
    rollupUptime(db, since90d),
    db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM incidents WHERE status <> 'resolved'`,
    ),
    db.query<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = 'last_sweep_at'`,
    ),
  ]);

  let up = 0;
  let down = 0;
  let degraded = 0;
  for (const row of statuses.rows) {
    if (row.status === 'up') up += Number(row.n);
    else if (row.status === 'degraded') degraded += Number(row.n);
    else if (row.status === 'down') down += Number(row.n);
  }

  const total = Number(counts.rows[0]?.total ?? 0);
  const activeCount = Number(counts.rows[0]?.active ?? 0);

  return c.json({
    overview: {
      total,
      up,
      down,
      degraded,
      paused: total - activeCount,
      uptime_24h: uptime24h.rows[0]?.uptime ?? null,
      uptime_90d: uptime90d.rows[0]?.uptime ?? null,
      avg_response_time_ms: await averageLatency24h(db),
      active_incidents: Number(incidents.rows[0]?.n ?? 0),
      last_sweep_at: lastSweep.rows[0]?.value ?? null,
      next_sweep_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
});

/**
 * Weighted uptime from raw checks, active monitors only.
 *
 * One row out rather than one per monitor. The caller wants a single figure,
 * and aggregating in SQL weights by check volume -- which is what the previous
 * implementation produced by averaging after a per-monitor pass, since monitors
 * accumulate checks at different rates.
 */
async function windowUptime(db: DatabaseAdapter, since: string) {
  return db.query<{ total: number; up: number; uptime: number | null }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN c.status = 'up' THEN 1 ELSE 0 END) AS up,
            CASE WHEN COUNT(*) = 0 THEN NULL
                 ELSE ROUND(SUM(CASE WHEN c.status = 'up' THEN 1 ELSE 0 END) * 10000.0 / COUNT(*)) / 100
            END AS uptime
       FROM checks c
       JOIN monitors m ON m.id = c.monitor_id
      WHERE m.active = ? AND c.checked_at >= ? AND c.status <> 'degraded'`,
    [true, since],
  );
}

/**
 * Weighted uptime from the nightly rollup, active monitors only.
 *
 * NULL rather than zero when there is no history: on a fresh instance the
 * honest answer is "we do not know yet", and the UI already renders that as an em dash.
 */
async function rollupUptime(db: DatabaseAdapter, sinceDate: string) {
  return db.query<{ total: number; up: number; uptime: number | null }>(
    `SELECT SUM(d.total_checks) AS total,
            SUM(d.up_checks) AS up,
            CASE WHEN SUM(d.total_checks) IS NULL OR SUM(d.total_checks) = 0 THEN NULL
                 ELSE ROUND(SUM(d.up_checks) * 10000.0 / SUM(d.total_checks)) / 100
            END AS uptime
       FROM daily_status d
       JOIN monitors m ON m.id = d.monitor_id
      WHERE m.active = ? AND d.date >= ?`,
    [true, sinceDate],
  );
}

/** Per-colo rollup for the edge map. */
monitorRoutes.get('/edge', async (c) => {
  const stats = await edgeNodeStats(c.get('db'), 24);
  const nodes: EdgeNode[] = await collectEdgeNodes(c.get('db'), stats);

  return c.json({
    nodes,
    // Every colo we know about, so the map can render dormant regions too.
    total_colos: new Set(nodes.map((node) => node.colo)).size,
  });
});

monitorRoutes.get('/:id', validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const monitor = await repo.getById(c.get('db'), id);
  if (!monitor) throw HttpError.notFound('Monitor not found');
  return c.json({ monitor });
});

monitorRoutes.get(
  '/:id/checks',
  validateParam(idParamSchema),
  validateQuery(checkHistoryQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { limit, days } = c.req.valid('query');

    const db = c.get('db');
    if (!(await repo.exists(db, id))) throw HttpError.notFound('Monitor not found');

    const [checks, daily] = await Promise.all([
      repo.recentChecks(db, id, limit),
      repo.dailyStatus(db, id, days),
    ]);

    return c.json({ checks, daily });
  },
);

/** Run one check immediately, without waiting for the next cron tick. */
monitorRoutes.post('/:id/check', validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');

  const monitor = await repo.getById(db, id);
  if (!monitor) throw HttpError.notFound('Monitor not found');

  // `admin` because a manual check costs real subrequests.
  if (c.get('user')?.role !== 'admin') {
    throw HttpError.forbidden('Only an admin can trigger a check manually');
  }

  const outcome = await runCheck(monitor, {
    policy: { allowPrivateTargets: c.get('config').allowPrivateTargets },
  });

  const cf = (c.req.raw as { cf?: RequestCfLike }).cf;
  const colo = cf?.colo ?? null;

  await repo.insertChecks(db, [
    {
      monitorId: monitor.id,
      status: outcome.status,
      responseTimeMs: outcome.responseTimeMs,
      statusCode: outcome.statusCode,
      errorMessage: outcome.errorMessage,
      colo,
      region: colo ? (lookupColo(colo)?.region ?? null) : null,
    },
  ]);

  return c.json({ result: outcome });
});

monitorRoutes.post('/', requireAuth('editor'), validateJson(createMonitorSchema), async (c) => {
  const body = c.req.valid('json');
  const db = c.get('db');

  assertTargetAllowed(body, c.get('config').allowPrivateTargets);

  const monitor = await repo.insert(db, {
    ...body,
    headers: body.headers ?? null,
  });

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'monitor.create',
    target: monitor.id,
    ok: true,
    ip: c.get('clientIp'),
  });

  return c.json({ monitor }, 201);
});

monitorRoutes.patch(
  '/:id',
  requireAuth('editor'),
  validateParam(idParamSchema),
  validateJson(updateMonitorSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const db = c.get('db');

    const existing = await repo.getById(db, id);
    if (!existing) throw HttpError.notFound('Monitor not found');

    assertTargetAllowed(
      {
        kind: body.kind ?? existing.kind,
        url: body.url === undefined ? existing.url : body.url,
        script: body.script === undefined ? existing.script : body.script,
      },
      c.get('config').allowPrivateTargets,
    );

    const monitor = await repo.update(db, id, body);
    if (!monitor) throw HttpError.notFound('Monitor not found');

    await audit(db, {
      userId: c.get('user')?.id ?? null,
      action: 'monitor.update',
      target: id,
      ok: true,
      ip: c.get('clientIp'),
    });

    return c.json({ monitor });
  },
);

monitorRoutes.delete('/:id', requireAuth('admin'), validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');

  const removed = await repo.remove(db, id);
  if (!removed) throw HttpError.notFound('Monitor not found');

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'monitor.delete',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  return c.json({ ok: true });
});

/** Pause/resume without losing history. */
monitorRoutes.post(
  '/:id/toggle',
  requireAuth('editor'),
  validateParam(idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const db = c.get('db');

    const existing = await repo.getById(db, id);
    if (!existing) throw HttpError.notFound('Monitor not found');

    const monitor = await repo.update(db, id, { active: !existing.active });
    return c.json({ monitor });
  },
);

// --- helpers -----------------------------------------------------------------

/**
 * Re-check the target against the SSRF policy before persisting it.
 *
 * Zod has already validated the URL's shape; this catches the "valid URL that
 * points at your cloud metadata" case, which shape validation cannot see.
 */
function assertTargetAllowed(
  input: { kind?: string; url?: string | null; script?: string | null },
  allowPrivateTargets: boolean,
): void {
  if (input.kind !== 'http' || !input.url) return;

  const policy = { ...DEFAULT_POLICY, allowPrivateTargets };

  try {
    validateUrl(input.url, policy);
  } catch (error) {
    if (error instanceof SsrfError) {
      throw HttpError.badRequest(
        `This URL cannot be monitored: ${error.reason}. Set ALLOW_PRIVATE_TARGETS=true to permit it.`,
        { reason: error.reason },
      );
    }
    throw error;
  }
}

/** Mean of the non-null values, or null when there are none. */
function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) return null;
  return Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 100) / 100;
}

export type { Monitor };

import { Hono } from 'hono';
import { validateJson, validateQuery, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import { requireAuth } from '../middleware/context.ts';
import type { AppEnv } from '../middleware/context.ts';
import { apiRateLimit } from '../middleware/ratelimit.ts';
import { nowIso } from '../db/dialect.ts';
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

monitorRoutes.use('*', apiRateLimit(), requireAuth('viewer'));

monitorRoutes.get('/', validateQuery(listMonitorsQuerySchema), async (c) => {
  const query = c.req.valid('query');

  const monitors = await repo.listWithStatus(c.get('db'), {
    groupId: query.group,
    status: query.status,
    active: query.active,
    limit: query.limit,
    includeDaily: query.include_uptime,
  });

  return c.json({ monitors });
});

monitorRoutes.get('/overview', async (c) => {
  const db = c.get('db');
  const monitors = await repo.listWithStatus(db, { limit: 500 });

  const total = monitors.length;
  const active = monitors.filter((monitor) => monitor.active);
  let up = 0;
  let down = 0;
  let degraded = 0;
  for (const monitor of active) {
    if (monitor.current_status === 'up') up += 1;
    else if (monitor.current_status === 'degraded') degraded += 1;
    else if (monitor.current_status === 'down') down += 1;
  }

  const weighted24h = average(
    monitors.map((monitor) => monitor.uptime_24h),
  );
  const weighted90d = average(
    monitors.map((monitor) => monitor.uptime_90d),
  );
  const avgLatency = average(
    monitors.map((monitor) => monitor.avg_response_time_ms),
  );

  const incidents = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM incidents WHERE status <> 'resolved'`,
  );

  const lastSweep = await db.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'last_sweep_at'`,
  );

  return c.json({
    overview: {
      total,
      up,
      down,
      degraded,
      paused: total - active.length,
      uptime_24h: weighted24h,
      uptime_90d: weighted90d,
      avg_response_time_ms: avgLatency,
      active_incidents: Number(incidents.rows[0]?.n ?? 0),
      last_sweep_at: lastSweep.rows[0]?.value ?? null,
      next_sweep_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
});

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
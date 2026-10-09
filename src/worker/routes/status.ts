import { Hono } from 'hono';
import { validateJson, validateQuery, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import type { AppEnv } from '../middleware/context.ts';
import { apiRateLimit } from '../middleware/ratelimit.ts';
import * as repo from '../repository/monitors.ts';
import { statusPageQuerySchema, slugParamSchema } from '../../shared/schemas.ts';
import { nowIso } from '../db/dialect.ts';
import type { Incident, IncidentStatus, MonitorStatus } from '../../shared/types.ts';

/**
 * Public status pages.
 *
 * These routes are intentionally unauthenticated — that is the product. They
 * only ever return data for groups flagged `is_public`, and the projection is
 * narrow: names, status, uptime, latency. Never URLs, headers, scripts or
 * error messages, which routinely contain internal hostnames and credentials.
 */

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.use('*', apiRateLimit());

interface GroupRow {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  theme: string | null;
  is_public: unknown;
  display_order: number;
}

/** Overall status of a set of monitors: worst-case wins. */
function rollupStatus(statuses: Array<MonitorStatus | null>): MonitorStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.length > 0 && statuses.every((status) => status === 'up')) return 'up';
  return 'degraded';
}

/** GET /api/public/status — the aggregate status of every public group. */
publicRoutes.get('/status', validateQuery(statusPageQuerySchema), async (c) => {
  const { days } = c.req.valid('query');
  const db = c.get('db');

  const groups = await db.query<GroupRow>(
    `SELECT id, name, slug, description, theme, is_public, display_order
       FROM monitor_groups
      WHERE is_public = ?
      ORDER BY display_order ASC, name ASC`,
    [true],
  );

  /**
   * Empty state.
   *
   * Every field of the normal response must still be present here. An earlier
   * version returned a short object, and the client then crashed on
   * `status.incidents.filter(...)`. A partial response is a worse contract
   * than an error, because it only fails at the call site that happens to read
   * the missing field.
   */
  if (groups.rows.length === 0) {
    return c.json({
      app_name: c.get('config').appName,
      days,
      overall: 'up' as const,
      groups: [],
      incidents: [],
      generated_at: nowIso(),
    });
  }

  const ids = groups.rows.map((row) => String(row.id));
  const placeholders = ids.map(() => '?').join(', ');

  const monitors = await repo.listWithStatus(db, {
    limit: 500,
  }).then((all) => all.filter((monitor) => monitor.group_id !== null && ids.includes(monitor.group_id)));

  const dailyRows = await db.query<{ monitor_id: string; date: string; total_checks: number; up_checks: number }>(
    `SELECT monitor_id, date, total_checks, up_checks
       FROM daily_status
      WHERE monitor_id IN (${placeholders})
        AND date >= ?
      ORDER BY date ASC`,
    [...ids, new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)],
  );

  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const windowRows = await db.query<{ monitor_id: string; total: number; up: number }>(
    `SELECT monitor_id, COUNT(*) AS total,
            SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
       FROM checks
      WHERE monitor_id IN (${placeholders}) AND checked_at >= ? AND status <> 'degraded'
      GROUP BY monitor_id`,
    [...ids, since24h],
  );

  const windowById = new Map(windowRows.rows.map((row) => [String(row.monitor_id), row]));

  const incidents = await db.query<Incident>(
    `SELECT * FROM incidents
      WHERE status <> 'resolved' AND (group_id IS NULL OR group_id IN (${placeholders}))
      ORDER BY created_at DESC`,
    ids,
  );

  const dailyByMonitor = new Map<string, Array<{ date: string; uptime: number }>>();
  for (const row of dailyRows.rows) {
    const key = String(row.monitor_id);
    const total = Number(row.total_checks) || 0;
    const uptime = total === 0 ? 100 : Math.round((Number(row.up_checks) / total) * 10_000) / 100;
    const list = dailyByMonitor.get(key) ?? [];
    list.push({ date: String(row.date), uptime });
    dailyByMonitor.set(key, list);
  }

  const payload = groups.rows.map((group) => {
    const groupMonitors = monitors.filter((monitor) => monitor.group_id === group.id);

    return {
      id: String(group.id),
      name: String(group.name),
      slug: group.slug,
      description: group.description,
      theme: group.theme,
      status: rollupStatus(groupMonitors.map((monitor) => monitor.current_status)),
      monitors: groupMonitors.map((monitor) => {
        const window = windowById.get(monitor.id);
        const total = window ? Number(window.total) || 0 : 0;

        return {
          id: monitor.id,
          // Name only — the URL can contain a secret path or internal hostname.
          name: monitor.name,
          status: monitor.current_status,
          uptime_24h:
            total === 0
              ? monitor.uptime_24h
              : Math.round(((Number(window?.up) || 0) / total) * 10_000) / 100,
          response_time_ms: monitor.last_check?.response_time_ms ?? null,
          checked_at: monitor.last_check?.checked_at ?? null,
          daily: dailyByMonitor.get(monitor.id) ?? [],
        };
      }),
    };
  });

  return c.json({
    app_name: c.get('config').appName,
    days,
    overall: rollupStatus(payload.map((group) => group.status)),
    groups: payload,
    incidents: incidents.rows.map((incident) => ({
      id: incident.id,
      title: incident.title,
      status: incident.status as IncidentStatus,
      impact: incident.impact,
      created_at: incident.created_at,
      resolved_at: incident.resolved_at,
    })),
    generated_at: new Date().toISOString(),
  });
});

/** GET /api/public/status/:slug — one group's status page. */
publicRoutes.get('/status/:slug', validateParam(slugParamSchema), validateQuery(statusPageQuerySchema), async (c) => {
  const { slug } = c.req.valid('param');
  const { days } = c.req.valid('query');
  const db = c.get('db');

  const group = await db.query<GroupRow>(
    `SELECT id, name, slug, description, theme, is_public, display_order
       FROM monitor_groups
      WHERE slug = ? AND is_public = ?`,
    [slug, true],
  );

  const row = group.rows[0];
  if (!row) throw HttpError.notFound('No public status page with that slug');

  const all = await repo.listWithStatus(db, { limit: 500 });
  const monitors = all.filter((monitor) => monitor.group_id === String(row.id));

  const daily = await db.query<{
    monitor_id: string;
    date: string;
    total_checks: number;
    up_checks: number;
  }>(
    `SELECT monitor_id, date, total_checks, up_checks FROM daily_status
      WHERE monitor_id IN (SELECT id FROM monitors WHERE group_id = ?)
        AND date >= ?
      ORDER BY date ASC`,
    [String(row.id), new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)],
  );

  // Per-monitor daily bars, keyed for O(1) lookup when building the payload.
  const dailyByMonitor = new Map<string, Array<{ date: string; uptime: number }>>();
  for (const entry of daily.rows) {
    const total = Number(entry.total_checks) || 0;
    const uptime = total === 0 ? 100 : Math.round((Number(entry.up_checks) / total) * 10_000) / 100;
    const key = String(entry.monitor_id);
    const list = dailyByMonitor.get(key) ?? [];
    list.push({ date: String(entry.date), uptime });
    dailyByMonitor.set(key, list);
  }

  return c.json({
    app_name: c.get('config').appName,
    group: {
      id: String(row.id),
      name: String(row.name),
      slug: row.slug,
      description: row.description,
      theme: row.theme,
      status: rollupStatus(monitors.map((monitor) => monitor.current_status)),
      monitors: monitors.map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        status: monitor.current_status,
        uptime_24h: monitor.uptime_24h,
        uptime_90d: monitor.uptime_90d,
        response_time_ms: monitor.last_check?.response_time_ms ?? null,
        checked_at: monitor.last_check?.checked_at ?? null,
      })),
    },
    daily: daily.rows.map((entry) => {
      const total = Number(entry.total_checks) || 0;
      return {
        date: String(entry.date),
        uptime: total === 0 ? 100 : Math.round((Number(entry.up_checks) / total) * 10_000) / 100,
      };
    }),
    days,
    generated_at: new Date().toISOString(),
  });
});

/** GET /api/public/incidents — public incident timeline with updates. */
publicRoutes.get('/incidents', async (c) => {
  const db = c.get('db');

  const incidents = await db.query<Incident>(
    `SELECT * FROM incidents
      WHERE status <> 'resolved' OR resolved_at >= ?
      ORDER BY created_at DESC
      LIMIT 50`,
    [new Date(Date.now() - 30 * 86_400_000).toISOString()],
  );

  if (incidents.rows.length === 0) return c.json({ incidents: [] });

  const ids = incidents.rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  const updates = await db.query<{
    id: string;
    incident_id: string;
    status: string;
    message: string;
    created_at: string;
  }>(
    `SELECT * FROM incident_updates WHERE incident_id IN (${placeholders}) ORDER BY created_at ASC`,
    ids,
  );

  const updatesByIncident = new Map<string, Array<Record<string, unknown>>>();
  for (const update of updates.rows) {
    const list = updatesByIncident.get(String(update.incident_id)) ?? [];
    list.push(update);
    updatesByIncident.set(String(update.incident_id), list);
  }

  return c.json({
    incidents: incidents.rows.map((incident) => ({
      id: incident.id,
      title: incident.title,
      status: incident.status,
      impact: incident.impact,
      created_at: incident.created_at,
      resolved_at: incident.resolved_at,
      updates: updatesByIncident.get(incident.id) ?? [],
    })),
  });
});
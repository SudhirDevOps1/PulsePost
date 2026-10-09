import { Hono } from 'hono';

import { validateJson, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import { requireAuth } from '../middleware/context.ts';
import type { AppEnv } from '../middleware/context.ts';
import { apiRateLimit } from '../middleware/ratelimit.ts';
import { nowIso } from '../db/dialect.ts';
import { toBool } from '../auth/session.ts';
import { audit } from './auth.ts';
import { createIncidentSchema, updateIncidentSchema, idParamSchema } from '../../shared/schemas.ts';
import type { Incident, IncidentImpact, IncidentStatus, IncidentUpdate } from '../../shared/types.ts';

/**
 * Incidents — the human-facing half of monitoring.
 *
 * A check going down is a fact; an incident is a story you tell customers.
 * Keeping them separate matters: the first responder decides when to open one,
 * and the timeline updates are the record everyone reads afterwards.
 */

export const incidentRoutes = new Hono<AppEnv>();

incidentRoutes.use('*', apiRateLimit(), requireAuth('viewer'));

interface IncidentRow {
  id: string;
  title: string;
  status: string;
  impact: string;
  group_id: string | null;
  auto_created: unknown;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

/**
 * `updates` is always present, defaulting to an empty list.
 *
 * A conditional spread would make the field vanish on some responses and not
 * others, so a client doing `incident.updates.length` would throw on exactly
 * the freshly-created case.
 */
function mapIncident(row: IncidentRow, updates: IncidentUpdate[] = []): Incident {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as IncidentStatus,
    impact: row.impact as IncidentImpact,
    group_id: row.group_id === null ? null : String(row.group_id),
    auto_created: toBool(row.auto_created),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    resolved_at: row.resolved_at === null ? null : String(row.resolved_at),
    updates,
  };
}

incidentRoutes.get('/', async (c) => {
  const db = c.get('db');
  const includeResolved = c.req.query('include_resolved') !== 'false';

  const result = await db.query<IncidentRow>(
    `SELECT * FROM incidents ${includeResolved ? '' : "WHERE status <> 'resolved'"}
      ORDER BY created_at DESC LIMIT 200`,
  );

  if (result.rows.length === 0) return c.json({ incidents: [] });

  const ids = result.rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  const updates = await db.query<IncidentUpdate>(
    `SELECT * FROM incident_updates WHERE incident_id IN (${placeholders}) ORDER BY created_at ASC`,
    ids,
  );

  const byIncident = new Map<string, IncidentUpdate[]>();
  for (const update of updates.rows) {
    const list = byIncident.get(update.incident_id) ?? [];
    list.push(update);
    byIncident.set(update.incident_id, list);
  }

  return c.json({
    incidents: result.rows.map((row) => mapIncident(row, byIncident.get(row.id) ?? [])),
  });
});

incidentRoutes.get('/:id', validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');

  const result = await db.query<IncidentRow>('SELECT * FROM incidents WHERE id = ?', [id]);
  const row = result.rows[0];
  if (!row) throw HttpError.notFound('Incident not found');

  const updates = await db.query<IncidentUpdate>(
    'SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at ASC',
    [id],
  );

  return c.json({ incident: mapIncident(row, updates.rows) });
});

incidentRoutes.post('/', requireAuth('editor'), validateJson(createIncidentSchema), async (c) => {
  const db = c.get('db');
  const body = c.req.valid('json');

  const id = crypto.randomUUID();
  const now = nowIso();
  // An incident opened as "resolved" is a contradiction — it would have no
  // outage to describe. Clamp to "investigating" and leave resolved_at NULL.
  const status = body.status === 'resolved' ? 'investigating' : body.status;
  const resolvedAt: string | null = null;

  // Write the incident and its first timeline entry atomically — an incident
  // with no updates would render as an empty card.
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO incidents (id, title, status, impact, group_id, auto_created, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.title,
        status,
        body.impact,
        body.group_id ?? null,
        false,
        now,
        now,
        resolvedAt,
      ],
    );

    if (body.message) {
      await tx.execute(
        `INSERT INTO incident_updates (id, incident_id, status, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), id, status, body.message, now],
      );
    }
  });

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'incident.create',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  const created = await db.query<IncidentRow>('SELECT * FROM incidents WHERE id = ?', [id]);
  // Read the timeline back too, so the response matches what a subsequent GET
  // returns rather than showing an incident with an empty history.
  const updates = await db.query<IncidentUpdate>(
    'SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at ASC',
    [id],
  );

  return c.json({ incident: mapIncident(created.rows[0]!, updates.rows) }, 201);
});

incidentRoutes.patch(
  '/:id',
  requireAuth('editor'),
  validateParam(idParamSchema),
  validateJson(updateIncidentSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const existing = await db.query<IncidentRow>('SELECT * FROM incidents WHERE id = ?', [id]);
    const row = existing.rows[0];
    if (!row) throw HttpError.notFound('Incident not found');

    const now = nowIso();
    const nextStatus = body.status ?? (row.status as IncidentStatus);

    // resolved_at is derived from status rather than set by the caller, so the
    // two can never disagree.
    const resolvedAt = nextStatus === 'resolved' ? (row.resolved_at ?? now) : null;

    const columns: Record<string, unknown> = {
      title: body.title,
      status: body.status,
      impact: body.impact,
      group_id: body.group_id,
    };

    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(value);
    }

    assignments.push('updated_at = ?', 'resolved_at = ?');
    values.push(now, resolvedAt, id);

    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE incidents SET ${assignments.join(', ')} WHERE id = ?`,
        values,
      );

      // A status change always leaves a timeline entry, even without a message.
      if (body.status && body.status !== row.status) {
        await tx.execute(
          `INSERT INTO incident_updates (id, incident_id, status, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            id,
            body.status,
            body.message ?? `Status changed to ${body.status}`,
            now,
          ],
        );
      } else if (body.message) {
        await tx.execute(
          `INSERT INTO incident_updates (id, incident_id, status, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), id, nextStatus, body.message, now],
        );
      }
    });

    await audit(db, {
      userId: c.get('user')?.id ?? null,
      action: 'incident.update',
      target: id,
      ok: true,
      ip: c.get('clientIp'),
    });

    const updated = await db.query<IncidentRow>('SELECT * FROM incidents WHERE id = ?', [id]);
    const timeline = await db.query<IncidentUpdate>(
      'SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at ASC',
      [id],
    );

    return c.json({ incident: mapIncident(updated.rows[0]!, timeline.rows) });
  },
);

incidentRoutes.delete('/:id', requireAuth('admin'), validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');

  const result = await db.execute('DELETE FROM incidents WHERE id = ?', [id]);
  if (result.changes === 0) throw HttpError.notFound('Incident not found');

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'incident.delete',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  return c.json({ ok: true });
});

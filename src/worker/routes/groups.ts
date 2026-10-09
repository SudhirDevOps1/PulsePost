import { Hono } from 'hono';

import { validateJson, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import { requireAuth } from '../middleware/context.ts';
import type { AppEnv } from '../middleware/context.ts';
import { apiRateLimit } from '../middleware/ratelimit.ts';
import { nowIso } from '../db/dialect.ts';
import { toBool } from '../auth/session.ts';
import { countByGroup } from '../repository/monitors.ts';
import { audit } from './auth.ts';
import {
  createGroupSchema,
  updateGroupSchema,
  idParamSchema,
} from '../../shared/schemas.ts';
import type { MonitorGroup } from '../../shared/types.ts';

/**
 * Monitor groups.
 *
 * A group is the unit of organisation *and* the unit of publication: marking
 * one `is_public` is what puts it on `/status`. Without these routes the public
 * status page could never be populated at all, which is why they exist rather
 * than being folded into the monitors router.
 *
 * Deleting a group is non-destructive for monitors — the schema sets
 * `ON DELETE SET NULL`, so monitors survive and simply become ungrouped.
 */

export const groupRoutes = new Hono<AppEnv>();

groupRoutes.use('*', apiRateLimit(), requireAuth('viewer'));

interface GroupRow {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  theme: string | null;
  is_public: unknown;
  display_order: number;
  created_at: string;
  updated_at: string;
}

function mapGroup(row: GroupRow): MonitorGroup {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: row.slug === null ? null : String(row.slug),
    description: row.description === null ? null : String(row.description),
    theme: row.theme === null ? null : String(row.theme),
    is_public: toBool(row.is_public),
    display_order: Number(row.display_order) || 0,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

groupRoutes.get('/', async (c) => {
  const result = await c.get('db').query<GroupRow>(
    `SELECT * FROM monitor_groups ORDER BY display_order ASC, name ASC`,
  );
  return c.json({ groups: result.rows.map(mapGroup) });
});

groupRoutes.get('/:id', validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const result = await c.get('db').query<GroupRow>('SELECT * FROM monitor_groups WHERE id = ?', [id]);
  const row = result.rows[0];
  if (!row) throw HttpError.notFound('Group not found');
  return c.json({ group: mapGroup(row) });
});

groupRoutes.post('/', requireAuth('editor'), validateJson(createGroupSchema), async (c) => {
  const db = c.get('db');
  const body = c.req.valid('json');

  if (body.slug) {
    const clash = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM monitor_groups WHERE slug = ?',
      [body.slug],
    );
    if (Number(clash.rows[0]?.n ?? 0) > 0) {
      throw HttpError.conflict('That slug is already in use');
    }
  }

  const id = crypto.randomUUID();
  const now = nowIso();

  await db.execute(
    `INSERT INTO monitor_groups (id, name, slug, description, theme, is_public, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.slug ?? null,
      body.description ?? null,
      body.theme ?? null,
      body.is_public,
      body.display_order,
      now,
      now,
    ],
  );

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'group.create',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  const created = await db.query<GroupRow>('SELECT * FROM monitor_groups WHERE id = ?', [id]);
  return c.json({ group: mapGroup(created.rows[0]!) }, 201);
});

groupRoutes.patch(
  '/:id',
  requireAuth('editor'),
  validateParam(idParamSchema),
  validateJson(updateGroupSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const existing = await db.query<GroupRow>('SELECT * FROM monitor_groups WHERE id = ?', [id]);
    if (!existing.rows[0]) throw HttpError.notFound('Group not found');

    if (body.slug) {
      const clash = await db.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM monitor_groups WHERE slug = ? AND id <> ?',
        [body.slug, id],
      );
      if (Number(clash.rows[0]?.n ?? 0) > 0) {
        throw HttpError.conflict('That slug is already in use');
      }
    }

    // Only keys present in the body are written, so a PATCH cannot blank a
    // field the caller did not mention.
    const columns: Record<string, unknown> = {
      name: body.name,
      slug: body.slug,
      description: body.description,
      theme: body.theme,
      is_public: body.is_public,
      display_order: body.display_order,
    };

    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(value);
    }

    if (assignments.length > 0) {
      assignments.push('updated_at = ?');
      values.push(nowIso(), id);
      await db.execute(
        `UPDATE monitor_groups SET ${assignments.join(', ')} WHERE id = ?`,
        values,
      );
    }

    await audit(db, {
      userId: c.get('user')?.id ?? null,
      action: 'group.update',
      target: id,
      ok: true,
      ip: c.get('clientIp'),
    });

    const updated = await db.query<GroupRow>('SELECT * FROM monitor_groups WHERE id = ?', [id]);
    return c.json({ group: mapGroup(updated.rows[0]!) });
  },
);

groupRoutes.delete('/:id', requireAuth('admin'), validateParam(idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');

  // Monitors keep their history; the foreign key nulls their group_id.
  const affected = await countByGroup(db, id);

  const result = await db.execute('DELETE FROM monitor_groups WHERE id = ?', [id]);
  if (result.changes === 0) throw HttpError.notFound('Group not found');

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'group.delete',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
    meta: { orphaned_monitors: affected },
  });

  return c.json({ ok: true, orphaned_monitors: affected });
});
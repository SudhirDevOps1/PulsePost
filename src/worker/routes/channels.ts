import { Hono } from 'hono';
import { z } from 'zod';

import { validateJson, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import { requireAuth } from '../middleware/context.ts';
import type { AppEnv } from '../middleware/context.ts';
import { apiRateLimit, authRateLimit } from '../middleware/ratelimit.ts';
import { nowIso } from '../db/dialect.ts';
import { toBool } from '../auth/session.ts';
import { audit } from './auth.ts';
import {
  createChannelSchema,
  updateChannelSchema,
  linkChannelSchema,
  idParamSchema,
} from '../../shared/schemas.ts';
import type { ChannelType, NotificationChannel } from '../../shared/types.ts';

/**
 * Notification channels.
 *
 * Webhook URLs routinely embed a secret (`https://hooks.slack.com/services/T…/B…/xxx`).
 * That value is write-only: it is stored, never returned by any GET, and the
 * list endpoint reports only whether a URL is configured. An operator can
 * still see which channel is which, and can rotate by PATCHing a new URL.
 */

export const channelRoutes = new Hono<AppEnv>();

channelRoutes.use('*', apiRateLimit(), requireAuth('viewer'));

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  config: string;
  active: unknown;
  created_at: string;
}

/** Everything except the secret. */
function mapChannel(row: ChannelRow): NotificationChannel {
  const hasUrl = /"url"\s*:\s*"[^"]+"/.test(row.config);
  return {
    id: String(row.id),
    type: row.type as ChannelType,
    name: String(row.name),
    // Shape is preserved so the UI can tell "configured" from "empty", but the
    // value itself never leaves the server.
    config: JSON.stringify({ url: hasUrl ? '***' : '' }),
    active: toBool(row.active),
    created_at: String(row.created_at),
  };
}

channelRoutes.get('/', async (c) => {
  const db = c.get('db');

  const channels = await db.query<ChannelRow>(
    'SELECT * FROM notification_channels ORDER BY created_at ASC',
  );

  const links = await db.query<{ channel_id: string; monitor_id: string; notify_on: string; downtime_threshold_s: number }>(
    'SELECT channel_id, monitor_id, notify_on, downtime_threshold_s FROM monitor_notifications',
  );

  const byChannel = new Map<string, Array<{ monitor_id: string; notify_on: string; downtime_threshold_s: number }>>();
  for (const link of links.rows) {
    const list = byChannel.get(link.channel_id) ?? [];
    list.push({
      monitor_id: link.monitor_id,
      notify_on: link.notify_on,
      downtime_threshold_s: link.downtime_threshold_s,
    });
    byChannel.set(link.channel_id, list);
  }

  return c.json({
    channels: channels.rows.map((row) => ({
      ...mapChannel(row),
      monitors: byChannel.get(row.id) ?? [],
    })),
  });
});

channelRoutes.post('/', requireAuth('editor'), validateJson(createChannelSchema), async (c) => {
  const db = c.get('db');
  const body = c.req.valid('json');

  const id = crypto.randomUUID();

  await db.execute(
    'INSERT INTO notification_channels (id, type, name, config, active, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, body.type, body.name, JSON.stringify({ url: body.url }), true, nowIso()],
  );

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'channel.create',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
    // The URL is deliberately not logged — it is a credential.
  });

  const created = await db.query<ChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
  return c.json({ channel: mapChannel(created.rows[0]!) }, 201);
});

channelRoutes.patch(
  '/:id',
  requireAuth('editor'),
  validateParam(idParamSchema),
  validateJson(updateChannelSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const existing = await db.query<ChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    const row = existing.rows[0];
    if (!row) throw HttpError.notFound('Channel not found');

    if (body.name !== undefined) {
      await db.execute('UPDATE notification_channels SET name = ? WHERE id = ?', [body.name, id]);
    }
    if (body.active !== undefined) {
      await db.execute('UPDATE notification_channels SET active = ? WHERE id = ?', [body.active, id]);
    }
    if (body.url !== undefined) {
      await db.execute('UPDATE notification_channels SET config = ? WHERE id = ?', [
        JSON.stringify({ url: body.url }),
        id,
      ]);
    }

    await audit(db, {
      userId: c.get('user')?.id ?? null,
      action: 'channel.update',
      target: id,
      ok: true,
      ip: c.get('clientIp'),
    });

    const updated = await db.query<ChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    return c.json({ channel: mapChannel(updated.rows[0]!) });
  },
);

channelRoutes.delete('/:id', requireAuth('admin'), validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');

  // monitor_notifications cascades.
  const result = await db.execute('DELETE FROM notification_channels WHERE id = ?', [id]);
  if (result.changes === 0) throw HttpError.notFound('Channel not found');

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'channel.delete',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  return c.json({ ok: true });
});

/** Attach a channel to a monitor, with a per-monitor notify policy. */
channelRoutes.post(
  '/:id/link',
  requireAuth('editor'),
  validateParam(idParamSchema),
  validateJson(linkChannelSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const db = c.get('db');

    const channel = await db.query('SELECT id FROM notification_channels WHERE id = ?', [id]);
    if (channel.rows.length === 0) throw HttpError.notFound('Channel not found');

    // The monitor comes from a query parameter, not the body: the schema was
// written to carry the channel (which is already in the path), so the row was
// being inserted with `monitor_id = channel.id` and never matching a real
// monitor. Which monitor to attach was simply not reachable.
    const monitorId = c.req.query('monitor_id');
    if (!z.string().uuid().safeParse(monitorId).success) {
      throw HttpError.badRequest('A valid monitor_id query parameter is required');
    }

    const monitor = await db.query('SELECT id FROM monitors WHERE id = ?', [monitorId]);
    if (monitor.rows.length === 0) throw HttpError.notFound('Monitor not found');

    await db.execute(
      `INSERT INTO monitor_notifications (monitor_id, channel_id, notify_on, downtime_threshold_s)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (monitor_id, channel_id) DO UPDATE SET
         notify_on = excluded.notify_on,
         downtime_threshold_s = excluded.downtime_threshold_s`,
      [monitorId, id, body.notify_on, body.downtime_threshold_s],
    );

    return c.json({ ok: true });
  },
);

channelRoutes.delete('/:id/link/:monitorId', requireAuth('editor'), async (c) => {
  const id = c.req.param('id');
  const monitorId = c.req.param('monitorId');

  await c
    .get('db')
    .execute('DELETE FROM monitor_notifications WHERE monitor_id = ? AND channel_id = ?', [
      monitorId,
      id,
    ]);

  return c.json({ ok: true });
});

/**
 * Send a test notification.
 * Shares the auth rate limit: it performs an outbound request, so it must not
 * be usable as a free amplifier.
 */
channelRoutes.post('/:id/test', authRateLimit(), validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');

  const row = await db.query<ChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
  const channel = row.rows[0];
  if (!channel) throw HttpError.notFound('Channel not found');

  const { sendToChannel } = await import('../notifications/send.ts');

  const result = await sendToChannel(
    {
      id: String(channel.id),
      type: channel.type as ChannelType,
      name: String(channel.name),
      config: String(channel.config),
    },
    {
      monitorId: 'test',
      monitorName: 'Test notification',
      previousStatus: 'up',
      status: 'down',
      responseTimeMs: 0,
      statusCode: 503,
      errorMessage: 'This is a test — no action is required.',
      downSince: nowIso(),
      appName: c.get('config').appName,
    },
  );

  return c.json(
    { ok: result.ok, status: result.status, error: result.error },
    result.ok ? 200 : 502,
  );
});

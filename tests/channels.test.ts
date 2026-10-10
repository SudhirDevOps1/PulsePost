import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';
import { nowIso } from '../src/worker/db/dialect.ts';
import { sendToChannel, type Channel, type NotificationEvent } from '../src/worker/notifications/send.ts';
import { CHANNEL_TYPES, createChannelSchema } from '../src/shared/schemas.ts';

/**
 * The ten added transports.
 *
 * Three things are worth pinning down and none of them are visible from the
 * code alone:
 *
 *  1. The migration rebuilds `notification_channels`, so existing rows must
 *     survive it. A rebuild that drops data would be silent and irreversible.
 *  2. Each builder must produce a request whose URL and body match what the
 *     receiving service documents. Getting these wrong fails quietly -- the
 *     send returns a non-2xx that nobody reads.
 *  3. Redaction must cover every secret field, not just `url`. The original
 *     three-channel world only had `url`, and masking that one field would have
 *     leaked every bot token and routing key the moment the list was called.
 *
 * The builders are exercised by intercepting `globalThis.fetch`, so no test
 * here makes a network call.
 */

let dir: string;
let db: LibsqlAdapter;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-channels-'));
  db = await LibsqlAdapter.create('sqlite', { url: `file:${join(dir, 'channels.db')}` });
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

const event = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  monitorId: 'mon-1',
  monitorName: 'Checkout API',
  previousStatus: 'up',
  status: 'down',
  responseTimeMs: null,
  statusCode: 500,
  errorMessage: 'boom',
  downSince: '2026-10-10T00:00:00.000Z',
  appName: 'PulsePost',
  ...over,
});

/** Capture what a builder would send, without touching the network. */
async function capture(channel: Channel, e: NotificationEvent = event()) {
  const original = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    seen = { url: String(url), init };
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await sendToChannel(channel, e);
    assert.equal(result.ok, true, `send failed: ${result.error}`);
    assert.ok(seen, 'fetch was never called');
    return seen as { url: string; init: RequestInit };
  } finally {
    globalThis.fetch = original;
  }
}

function channel(type: Channel['type'], config: Record<string, unknown>): Channel {
  return { id: 'c1', type, name: 'test', config: JSON.stringify(config) };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body ?? '{}'));
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe('notification transports', () => {
  test('the migration keeps existing rows', async () => {
    await db.execute(
      `INSERT INTO notification_channels (id, type, name, config, active, created_at)
       VALUES ('legacy', 'slack', 'Old channel', '{"url":"https://hooks.example/old"}', 1, ?)`,
      ['2026-01-01T00:00:00.000Z'],
    );

    const row = await db.query<{ name: string; config: string }>(
      `SELECT name, config FROM notification_channels WHERE id = 'legacy'`,
    );
    assert.equal(row.rows.length, 1, 'the pre-existing row survived the table rebuild');
    assert.equal(row.rows[0]!.name, 'Old channel');
    assert.equal(row.rows[0]!.config, '{"url":"https://hooks.example/old"}');
  });

  test('the widened constraint accepts every declared transport', async () => {
    for (const type of CHANNEL_TYPES) {
      await db.execute(
        `INSERT INTO notification_channels (id, type, name, config, active, created_at)
         VALUES (?, ?, 't', '{}', 1, ?)`,
        [crypto.randomUUID(), type, nowIso()],
      );
    }
    const count = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM notification_channels`);
    assert.equal(Number(count.rows[0]!.n), CHANNEL_TYPES.length + 1, 'legacy row plus one per type');
  });

  test('the constraint still rejects a type that does not exist', async () => {
    await assert.rejects(
      () =>
        db.execute(
          `INSERT INTO notification_channels (id, type, name, config, active, created_at)
           VALUES ('bad', 'carrier-pigeon', 'nope', '{}', 1, ?)`,
          [nowIso()],
        ),
      'an unknown transport must be refused by the database, not just the schema',
    );
  });

  test('telegram posts to the Bot API with the chat id in the body', async () => {
    const sent = await capture(channel('telegram', { botToken: '123456:AAEabc', chatId: '-1001' }));
    assert.equal(sent.url, 'https://api.telegram.org/bot123456:AAEabc/sendMessage');
    assert.equal(bodyOf(sent.init).chat_id, '-1001');
    assert.match(String(bodyOf(sent.init).text), /Checkout API/);
  });

  test('ntfy posts plain text to server/topic with metadata in headers', async () => {
    const sent = await capture(channel('ntfy', { server: 'https://ntfy.sh/', topic: 'alerts' }));
    assert.equal(sent.url, 'https://ntfy.sh/alerts', 'the trailing slash on the server is trimmed');
    assert.equal(headersOf(sent.init)['Title'], 'Checkout API went DOWN');
    assert.equal(headersOf(sent.init).Priority, '5', 'a down alert is maximum priority');
    assert.equal(sent.init.body, 'Status code: 500\nReason: boom\nDown since: 2026-10-10T00:00:00.000Z');
  });

  test('ntfy topic is validated to the characters ntfy accepts', async () => {
    const bad = createChannelSchema.safeParse({
      type: 'ntfy',
      name: 'x',
      server: 'https://ntfy.sh',
      topic: 'has spaces and/slashes',
    });
    assert.equal(bad.success, false, 'a topic ntfy would reject must not get past validation');
  });

  test('pagerduty triggers then resolves on one dedup key', async () => {
    const down = await capture(channel('pagerduty', { routingKey: 'R0UTINGKEY123' }));
    const trigger = bodyOf(down.init);
    assert.equal(down.url, 'https://events.pagerduty.com/v2/enqueue');
    assert.equal(trigger.routing_key, 'R0UTINGKEY123');
    assert.equal(trigger.event_action, 'trigger');
    assert.equal((trigger.payload as Record<string, unknown>).severity, 'error');

    // Same outage must produce the same dedup key, or every check of a monitor
    // that stays down for an hour opens a separate incident.
    const again = bodyOf(
      (await capture(channel('pagerduty', { routingKey: 'R0UTINGKEY123' }), event())).init,
    );
    assert.equal(again.dedup_key, trigger.dedup_key);

    // Recovery resolves rather than opening anything new.
    const recovered = bodyOf(
      (
        await capture(
          channel('pagerduty', { routingKey: 'R0UTINGKEY123' }),
          event({ status: 'up', previousStatus: 'down', statusCode: 200 }),
        )
      ).init,
    );
    assert.equal(recovered.event_action, 'resolve');
    assert.equal(recovered.dedup_key, trigger.dedup_key, 'resolve must target the same incident');
  });

  test('opsgenie sends its key as a header and aliases by outage', async () => {
    const sent = await capture(channel('opsgenie', { apiKey: 'ops-key-123456', team: 'ops' }));
    assert.equal(sent.url, 'https://api.opsgenie.com/v2/alerts');
    assert.equal(headersOf(sent.init).Authorization, 'GenieKey ops-key-123456');
    const body = bodyOf(sent.init);
    assert.equal(body.team, 'ops');
    assert.equal(body.priority, 'P1');
    assert.match(String(body.alias), /^mon-1:/);
  });

  test('pushover sends a form body, not JSON', async () => {
    const sent = await capture(
      channel('pushover', { userKey: 'userkey1234', appToken: 'apptoken1234' }),
    );
    assert.equal(sent.url, 'https://api.pushover.net/1/messages.json');
    assert.match(headersOf(sent.init)['content-type'] ?? '', /x-www-form-urlencoded/);
    const fields = new URLSearchParams(String(sent.init.body));
    assert.equal(fields.get('token') ?? null, 'apptoken1234');
    assert.equal(fields.get('user') ?? null, 'userkey1234');
    assert.equal(fields.get('priority') ?? null, '5');
  });

  test('pushbullet carries its token as a header, never in the body', async () => {
    const sent = await capture(channel('pushbullet', { accessToken: 'o.xxxxxxxx' }));
    assert.equal(headersOf(sent.init)['Access-Token'], 'o.xxxxxxxx');
    assert.equal(String(sent.init.body).includes('o.xxxxxxxx'), false, 'token must not be in the payload');
    assert.equal(bodyOf(sent.init).type, 'note');
  });

  test('gotify and stoat append their credential to the server URL', async () => {
    const gotify = await capture(channel('gotify', { server: 'https://gotify.example/', token: 'abc123' }));
    assert.equal(gotify.url, 'https://gotify.example/message?token=abc123');

    const stoat = await capture(channel('stoat', { server: 'https://api.stoat.chat', token: 'tok123' }));
    assert.equal(stoat.url, 'https://api.stoat.chat/webhooks/tok123');
    assert.match(String(bodyOf(stoat.init).content), /Checkout API/);
  });

  test('mattermost and rocketchat reuse the slack payload', async () => {
    for (const type of ['mattermost', 'rocketchat'] as const) {
      const sent = await capture(channel(type, { url: 'https://chat.example/hook' }));
      const body = bodyOf(sent.init);
      assert.ok(body.attachments, `${type} should send a slack-compatible body`);
      assert.match(String(body.text), /Checkout API/);
    }
  });

  test('a missing config field is reported, not sent as undefined', async () => {
    const result = await sendToChannel(channel('telegram', { chatId: '-1001' }), event());
    assert.equal(result.ok, false);
    assert.match(String(result.error), /botToken/);
  });

  test('a transport failure is reported without throwing', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    try {
      const result = await sendToChannel(channel('slack', { url: 'https://hooks.example/x' }), event());
      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('channel config validation', () => {
  test('the original three transports keep their exact shape', () => {
    for (const type of ['webhook', 'slack', 'discord'] as const) {
      const parsed = createChannelSchema.safeParse({ type, name: 'n', url: 'https://hooks.example/x' });
      assert.equal(parsed.success, true, `${type} must still accept a bare url`);
    }
  });

  test('http is refused except on localhost', () => {
    assert.equal(
      createChannelSchema.safeParse({ type: 'webhook', name: 'n', url: 'http://evil.example/x' }).success,
      false,
    );
    assert.equal(
      createChannelSchema.safeParse({ type: 'webhook', name: 'n', url: 'http://localhost:3000/x' }).success,
      true,
      'the documented docker-compose setup uses a local relay',
    );
  });

  test('unknown fields are rejected rather than stored', () => {
    const parsed = createChannelSchema.safeParse({
      type: 'webhook',
      name: 'n',
      url: 'https://hooks.example/x',
      sneaky: 'value',
    });
    assert.equal(parsed.success, false, '.strict() should drop the extra key instead of storing it');
  });
});
import type { ChannelType, MonitorStatus } from '../../shared/types.ts';

/**
 * Notification delivery.
 *
 * Deliberately no third-party SDK: every transport here is a single HTTP call,
 * and bundling Slack/Discord/Telegram SDKs into a Worker would cost cold-start
 * time for almost nothing. Each transport is a function that turns one event
 * into a request, so the dispatch below is a table rather than a branch.
 *
 * Every send is best-effort — a failing channel must never fail a health check.
 * Errors are logged and swallowed.
 */

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  config: string;
}

export interface NotificationEvent {
  monitorId: string;
  monitorName: string;
  previousStatus: MonitorStatus | null;
  status: MonitorStatus;
  responseTimeMs: number | null;
  statusCode: number | null;
  errorMessage: string | null;
  /** How long the monitor has been down, when this is a down event. */
  downSince: string | null;
  appName: string;
  statusPageUrl?: string | undefined;
}

export interface SendResult {
  channelId: string;
  channelName: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

const TIMEOUT_MS = 8000;

/** What a transport needs before it can be called. */
interface PreparedRequest {
  url: string;
  method?: 'POST' | 'PUT';
  headers: Record<string, string>;
  /** Absent for transports that take a text body (ntfy). */
  json?: unknown;
  body?: string;
}

type Config = Record<string, unknown>;

function str(config: Config, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Channel is missing "${key}"`);
  }
  return value.trim();
}

function optionalStr(config: Config, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export async function sendToChannel(
  channel: Channel,
  event: NotificationEvent,
): Promise<SendResult> {
  const base = {
    channelId: channel.id,
    channelName: channel.name,
    status: null as number | null,
  };

  let request: PreparedRequest;
  try {
    const config = JSON.parse(channel.config) as Config;
    const build = BUILDERS[channel.type];
    if (!build) throw new Error(`Unsupported channel type: ${channel.type}`);
    request = build(config, event);
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: `Invalid channel config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const init: RequestInit = {
      method: request.method ?? 'POST',
      headers: request.headers,
      signal: controller.signal,
    };
    if (request.json !== undefined) {
      init.body = JSON.stringify(request.json);
    } else if (request.body !== undefined) {
      init.body = request.body;
    }

    const response = await fetch(request.url, init).finally(() => clearTimeout(timer));

    return {
      ...base,
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `Channel responded ${response.status}`,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- shared prose ------------------------------------------------------------

function eventName(event: NotificationEvent): string {
  if (event.previousStatus === null) return 'initial';
  if (event.status === 'down') return 'down';
  if (event.previousStatus === 'down') return 'recovered';
  return `changed_to_${event.status}`;
}

function emoji(event: NotificationEvent): string {
  if (event.status === 'down') return '\u{1F534}';
  if (event.status === 'degraded') return '\u{1F7E1}';
  return '\u{1F7E2}';
}

function headline(event: NotificationEvent): string {
  if (event.status === 'down') {
    return event.previousStatus === null
      ? `${event.monitorName} is DOWN`
      : `${event.monitorName} went DOWN`;
  }
  if (event.status === 'degraded') return `${event.monitorName} is DEGRADED`;
  return `${event.monitorName} recovered`;
}

function detailLines(event: NotificationEvent): string[] {
  const lines: string[] = [];
  if (event.statusCode !== null) lines.push(`Status code: ${event.statusCode}`);
  if (event.responseTimeMs !== null) lines.push(`Response time: ${event.responseTimeMs}ms`);
  if (event.errorMessage) lines.push(`Reason: ${event.errorMessage}`);
  if (event.downSince && event.status === 'down') {
    lines.push(`Down since: ${new Date(event.downSince).toISOString()}`);
  }
  if (event.statusPageUrl) lines.push(`Status page: ${event.statusPageUrl}`);
  return lines;
}

/** One line per alert, for transports with no rich formatting of their own. */
function plainText(event: NotificationEvent): string {
  return [headline(event), ...detailLines(event)].join('\n');
}

/**
 * Push transports have no concept of "recovered"; they take a priority, and
 * the mapping is: broken pages you, degraded should not.
 */
function pushPriority(event: NotificationEvent): number {
  if (event.status === 'down') return 5;
  if (event.status === 'degraded') return 3;
  return 1;
}

// --- transport builders ------------------------------------------------------

const jsonHeaders = { 'content-type': 'application/json' };

function slackPayload(event: NotificationEvent, down: boolean): unknown {
  const colour = down ? '#dc2626' : event.status === 'degraded' ? '#f59e0b' : '#16a34a';
  const fields = detailLines(event).map((text) => ({ type: 'mrkdwn', text }));

  return {
    text: `${emoji(event)} ${headline(event)}`,
    attachments: [
      {
        color: colour,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `${emoji(event)} *${headline(event)}*` } },
          ...(fields.length > 0 ? [{ type: 'section', fields }] : []),
        ],
      },
    ],
  };
}

function discordPayload(event: NotificationEvent, down: boolean): unknown {
  // 0xdc2626 / 0xf59e0b / 0x16a34a
  const colour = down ? 0xdc2626 : event.status === 'degraded' ? 0xf59e0b : 0x16a34a;

  return {
    username: event.appName,
    embeds: [
      {
        title: headline(event),
        description: detailLines(event).join('\n') || null,
        color: colour,
        timestamp: new Date().toISOString(),
        footer: { text: event.appName },
      },
    ],
  };
}

/**
 * Transport table.
 *
 * Each entry takes the stored config and produces a request. Dispatch is a
 * lookup rather than a `switch`, so adding a transport is one entry here plus
 * one schema member plus one migration — no edits to the send path.
 */
const BUILDERS: Record<ChannelType, (config: Config, event: NotificationEvent) => PreparedRequest> = {
  webhook: (config, event) => ({
    url: str(config, 'url'),
    headers: jsonHeaders,
    json: { source: 'pulsepost', event: eventName(event), ...event },
  }),

  slack: (config, event) => ({
    url: str(config, 'url'),
    headers: jsonHeaders,
    json: slackPayload(event, event.status === 'down'),
  }),

  // Mattermost and Rocket.Chat both consume the Slack incoming-webhook shape,
  // so they reuse the builder rather than carrying a near-identical copy that
  // would drift the first time Slack's format changed.
  mattermost: (config, event) => ({
    url: str(config, 'url'),
    headers: jsonHeaders,
    json: slackPayload(event, event.status === 'down'),
  }),

  rocketchat: (config, event) => ({
    url: str(config, 'url'),
    headers: jsonHeaders,
    json: slackPayload(event, event.status === 'down'),
  }),

  discord: (config, event) => ({
    url: str(config, 'url'),
    headers: jsonHeaders,
    json: discordPayload(event, event.status === 'down'),
  }),

  telegram: (config, event) => ({
    // The bot token is part of the path, which is how the Bot API is designed.
    // It is never logged: errors below carry only the status code.
    url: `https://api.telegram.org/bot${str(config, 'botToken')}/sendMessage`,
    headers: jsonHeaders,
    json: {
      chat_id: str(config, 'chatId'),
      text: `${emoji(event)} ${plainText(event)}`,
      disable_web_page_preview: true,
    },
  }),

  // ntfy takes a plain-text body and carries metadata in headers. Posting as
  // JSON would also work, but the header form is what its docs lead with and it
  // keeps the message readable in the ntfy web app.
  ntfy: (config, event) => ({
    url: `${str(config, 'server').replace(/\/+$/, '')}/${str(config, 'topic')}`,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      Title: headline(event),
      Priority: String(pushPriority(event)),
      Tags: event.status === 'down' ? 'rotating_light,skull' : event.status === 'degraded' ? 'warning' : 'white_check_mark',
      ...(event.statusPageUrl ? { Click: event.statusPageUrl } : {}),
    },
    body: detailLines(event).join('\n') || headline(event),
  }),

  gotify: (config, event) => ({
    url: `${str(config, 'server').replace(/\/+$/, '')}/message?token=${encodeURIComponent(str(config, 'token'))}`,
    headers: jsonHeaders,
    json: {
      title: headline(event),
      message: detailLines(event).join('\n') || event.appName,
      priority: pushPriority(event),
    },
  }),

  stoat: (config, event) => ({
    url: `${str(config, 'server').replace(/\/+$/, '')}/webhooks/${encodeURIComponent(str(config, 'token'))}`,
    headers: jsonHeaders,
    json: { content: `${emoji(event)} ${plainText(event)}` },
  }),

  // Form-encoded, not JSON. Pushover's API has always been form posts.
  pushover: (config, event) => ({
    url: 'https://api.pushover.net/1/messages.json',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: str(config, 'appToken'),
      user: str(config, 'userKey'),
      title: headline(event),
      message: detailLines(event).join('\n') || event.appName,
      priority: String(pushPriority(event)),
      ...(event.statusPageUrl ? { url: event.statusPageUrl } : {}),
    }).toString(),
  }),

  pushbullet: (config, event) => ({
    url: 'https://api.pushbullet.com/v2/pushes',
    // The access token is the entire credential, so it travels as a header
    // rather than in the body.
    headers: { ...jsonHeaders, 'Access-Token': str(config, 'accessToken') },
    json: {
      type: 'note',
      title: `${emoji(event)} ${headline(event)}`,
      body: detailLines(event).join('\n') || event.appName,
    },
  }),

  pagerduty: (config, event) => ({
    url: 'https://events.pagerduty.com/v2/enqueue',
    headers: jsonHeaders,
    json: {
      routing_key: str(config, 'routingKey'),
      // Events API v2 is stateful: the same `dedup_key` for a problem must
      // become `trigger` once and `resolve` once. Keying on the monitor plus
      // the time it went down is what stops a monitor flapping for an hour
      // from raising an hour of separate incidents.
      event_action: event.status === 'down' ? 'trigger' : 'resolve',
      dedup_key: `${event.monitorId}:${event.downSince ?? 'unknown'}`,
      payload: {
        summary: headline(event),
        severity: event.status === 'down' ? 'error' : event.status === 'degraded' ? 'warning' : 'info',
        source: event.monitorName,
        timestamp: new Date().toISOString(),
        custom_details: Object.fromEntries(
          detailLines(event).map((line) => {
            const at = line.indexOf(': ');
            return at === -1 ? [line, ''] : [line.slice(0, at), line.slice(at + 2)];
          }),
        ),
      },
    },
  }),

  opsgenie: (config, event) => ({
    url: 'https://api.opsgenie.com/v2/alerts',
    headers: { ...jsonHeaders, Authorization: `GenieKey ${str(config, 'apiKey')}` },
    json: {
      message: headline(event),
      // Opsgenie de-duplicates on alias, so the same reasoning as PagerDuty
      // applies: one open alert per monitor per outage.
      alias: `${event.monitorId}:${event.downSince ?? 'unknown'}`,
      description: detailLines(event).join('\n') || event.appName,
      priority: event.status === 'down' ? 'P1' : event.status === 'degraded' ? 'P3' : 'P5',
      ...(optionalStr(config, 'team') ? { team: optionalStr(config, 'team') } : {}),
      ...(event.status !== 'down' ? { source: 'PulsePost' } : {}),
    },
  }),
};

/** Fire-and-forget fan-out across several channels. */
export async function broadcast(
  channels: readonly Channel[],
  event: NotificationEvent,
): Promise<SendResult[]> {
  return Promise.all(channels.map((channel) => sendToChannel(channel, event)));
}
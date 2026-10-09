import type { ChannelType, MonitorStatus } from '../../shared/types.ts';

/**
 * Notification delivery.
 *
 * Deliberately no third-party SDK: each channel is a single JSON POST, and
 * bundling Slack/Discord SDKs into a Worker would cost cold-start time for
 * almost nothing.
 *
 * Every send is best-effort — a failing webhook must never fail a health
 * check. Errors are logged and swallowed.
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
  /** How long the monitor has been down, when it is a down event. */
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

export async function sendToChannel(
  channel: Channel,
  event: NotificationEvent,
): Promise<SendResult> {
  const base = { channelId: channel.id, channelName: channel.name, status: null as number | null };

  let url: string;
  try {
    const config = JSON.parse(channel.config) as { url?: string };
    if (!config.url) throw new Error('Channel has no URL configured');
    url = config.url;
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: `Invalid channel config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const payload = buildPayload(channel.type, event);
  if (!payload) {
    return { ...base, ok: false, error: `Unsupported channel type: ${channel.type}` };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload.body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

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

interface ChannelPayload {
  body: unknown;
}

function buildPayload(type: ChannelType, event: NotificationEvent): ChannelPayload | null {
  const down = event.status === 'down';

  switch (type) {
    case 'slack':
      return slackPayload(event, down);
    case 'discord':
      return discordPayload(event, down);
    case 'webhook':
      return { body: { source: 'pulsepost', event: eventName(event), ...event } };
    default:
      return null;
  }
}

function eventName(event: NotificationEvent): string {
  if (event.previousStatus === null) return 'initial';
  if (event.status === 'down') return 'down';
  if (event.previousStatus === 'down') return 'recovered';
  return `changed_to_${event.status}`;
}

function emoji(event: NotificationEvent): string {
  if (event.status === 'down') return event.previousStatus === null ? '\u{1F534}' : '\u{1F534}';
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

function slackPayload(event: NotificationEvent, down: boolean): ChannelPayload {
  const colour = down ? '#dc2626' : event.status === 'degraded' ? '#f59e0b' : '#16a34a';

  const fields = detailLines(event).map((text) => ({ type: 'mrkdwn', text }));

  return {
    body: {
      text: `${emoji(event)} ${headline(event)}`,
      attachments: [
        {
          color: colour,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `${emoji(event)} *${headline(event)}*` },
            },
            ...(fields.length > 0
              ? [{ type: 'section', fields }]
              : []),
          ],
        },
      ],
    },
  };
}

function discordPayload(event: NotificationEvent, down: boolean): ChannelPayload {
  // 0xdc2626 / 0xf59e0b / 0x16a34a
  const colour = down ? 0xdc2626 : event.status === 'degraded' ? 0xf59e0b : 0x16a34a;

  return {
    body: {
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
    },
  };
}

/** Fire-and-forget fan-out across several channels. */
export async function broadcast(
  channels: readonly Channel[],
  event: NotificationEvent,
): Promise<SendResult[]> {
  return Promise.all(channels.map((channel) => sendToChannel(channel, event)));
}
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, ApiError } from '../api.ts';
import type { ChannelType, MonitorWithStatus, NotificationChannel } from '../types.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Panel,
  Skeleton,
  inputClass,
  selectClass,
} from '../components/ui.tsx';

/**
 * Notification channels and their per-monitor subscriptions.
 *
 * This screen closes the gap that made alerting unusable: `/api/channels` had
 * been complete all along, but with no UI there was no way to add a webhook or
 * attach one to a monitor from inside the product.
 *
 * Channel URLs are write-only. The server redacts them on read (`***`), so the
 * edit form leaves the field blank when a URL already exists — submitting
 * without retyping it keeps the stored value rather than overwriting it with
 * a literal `***`.
 */

const TYPE_LABEL: Record<ChannelType, string> = {
  webhook: 'Webhook',
  slack: 'Slack',
  discord: 'Discord',
};

const TYPE_HINT: Record<ChannelType, string> = {
  webhook: 'Any HTTP endpoint. Receives a JSON POST on each alert.',
  slack: 'A Slack incoming-webhook URL.',
  discord: 'A Discord webhook URL.',
};

const NOTIFY_EVENTS = ['down', 'up', 'degraded'] as const;

export function ChannelsPage() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [monitors, setMonitors] = useState<MonitorWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [type, setType] = useState<ChannelType>('webhook');
  const [url, setUrl] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Per-channel subscription editor.
  const [editingLinks, setEditingLinks] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [channelResult, monitorResult] = await Promise.all([
        api.channels(),
        api.monitors({ limit: 200 }),
      ]);
      setChannels(channelResult.channels ?? []);
      setMonitors(monitorResult.monitors ?? []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load channels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const monitorName = useMemo(() => {
    const map = new Map<string, string>();
    for (const monitor of monitors) map.set(monitor.id, monitor.name);
    return map;
  }, [monitors]);

  async function create() {
    setBusy(true);
    setFieldErrors({});
    try {
      await api.createChannel({ type, name, url });
      setName('');
      setUrl('');
      setNotice('Channel created — now attach it to a monitor below');
      await load();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setFieldErrors(Object.fromEntries(cause.issues.map((i) => [i.field, i.message])));
        setError(cause.message);
      } else {
        setError('Could not create the channel');
      }
    } finally {
      setBusy(false);
    }
  }

  async function rename(channel: NotificationChannel, nextName: string) {
    setBusy(true);
    try {
      await api.updateChannel(channel.id, { name: nextName });
      setNotice('Channel renamed');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not rename the channel');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(channel: NotificationChannel) {
    setBusy(true);
    try {
      await api.updateChannel(channel.id, { active: !channel.active });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not update the channel');
    } finally {
      setBusy(false);
    }
  }

  async function replaceUrl(channel: NotificationChannel, nextUrl: string) {
    if (!nextUrl) return;
    setBusy(true);
    try {
      await api.updateChannel(channel.id, { url: nextUrl });
      setNotice('Channel URL updated');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not update the channel URL');
    } finally {
      setBusy(false);
    }
  }

  async function test(channel: NotificationChannel) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.testChannel(channel.id);
      setNotice(result.detail ?? 'Test notification sent');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(channel: NotificationChannel) {
    if (!confirm(`Delete "${channel.name}"? It will be detached from every monitor.`)) return;
    setBusy(true);
    try {
      await api.deleteChannel(channel.id);
      setNotice('Channel deleted');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not delete the channel');
    } finally {
      setBusy(false);
    }
  }

  async function attach(channel: NotificationChannel, monitorId: string) {
    if (!monitorId) return;
    setBusy(true);
    try {
      await api.linkChannel(channel.id, { monitor_id: monitorId });
      setNotice('Monitor attached');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not attach the monitor');
    } finally {
      setBusy(false);
    }
  }

  async function detach(channel: NotificationChannel, monitorId: string) {
    setBusy(true);
    try {
      await api.unlinkChannel(channel.id, monitorId);
      setNotice('Monitor detached');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not detach the monitor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Alerts</h1>
        <p className="text-xs text-[--color-text-tertiary]">
          Where to be told when something breaks. A channel only alerts on monitors it is attached to.
        </p>
      </header>

      {notice ? (
        <p className="text-xs text-[--color-up]" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <ErrorNote message={error} onRetry={() => void load()} /> : null}

      <Panel title="New channel">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="On-call webhook"
              maxLength={120}
            />
          </Field>

          <Field label="Type">
            <select className={selectClass} value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
              {(['webhook', 'slack', 'discord'] as ChannelType[]).map((value) => (
                <option key={value} value={value}>
                  {TYPE_LABEL[value]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="URL" hint={TYPE_HINT[type]} error={fieldErrors.url} className="sm:col-span-2">
            <input
              className={inputClass}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.example.com/..."
              type="url"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Button variant="primary" busy={busy} onClick={() => void create()}>
            Create channel
          </Button>
        </div>
      </Panel>

      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <Panel>
          <EmptyState
            title="No channels yet"
            description="Add a webhook, Slack or Discord endpoint above to start receiving alerts."
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              monitors={monitors}
              monitorName={monitorName}
              busy={busy}
              linksOpen={editingLinks === channel.id}
              onToggleLinks={() =>
                setEditingLinks(editingLinks === channel.id ? null : channel.id)
              }
              onRename={(next) => void rename(channel, next)}
              onToggleActive={() => void toggleActive(channel)}
              onReplaceUrl={(next) => void replaceUrl(channel, next)}
              onTest={() => void test(channel)}
              onDelete={() => void remove(channel)}
              onAttach={(monitorId) => void attach(channel, monitorId)}
              onDetach={(monitorId) => void detach(channel, monitorId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelCard({
  channel,
  monitors,
  monitorName,
  busy,
  linksOpen,
  onToggleLinks,
  onRename,
  onToggleActive,
  onReplaceUrl,
  onTest,
  onDelete,
  onAttach,
  onDetach,
}: {
  channel: NotificationChannel;
  monitors: MonitorWithStatus[];
  monitorName: Map<string, string>;
  busy: boolean;
  linksOpen: boolean;
  onToggleLinks: () => void;
  onRename: (name: string) => void;
  onToggleActive: () => void;
  onReplaceUrl: (url: string) => void;
  onTest: () => void;
  onDelete: () => void;
  onAttach: (monitorId: string) => void;
  onDetach: (monitorId: string) => void;
}) {
  const links = channel.monitors ?? [];
  const attached = new Set(links.map((link) => link.monitor_id));
  const available = monitors.filter((monitor) => !attached.has(monitor.id));
  const [draftName, setDraftName] = useState(channel.name);
  const [draftUrl, setDraftUrl] = useState('');
  const [pendingMonitor, setPendingMonitor] = useState('');

  return (
    <Panel
      title={channel.name}
      subtitle={`${TYPE_LABEL[channel.type]} · ${links.length} monitor${links.length === 1 ? '' : 's'}`}
      actions={
        <>
          <Badge>{TYPE_LABEL[channel.type]}</Badge>
          {channel.active ? (
            <Badge color="var(--color-up)">active</Badge>
          ) : (
            <Badge color="var(--color-paused)">paused</Badge>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={120}
              />
              <Button size="sm" busy={busy} onClick={() => onRename(draftName)}>
                Save
              </Button>
            </div>
          </Field>

          <Field
            label="URL"
            hint="Stored write-only. Leave blank to keep the current URL."
          >
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                placeholder={`${channel.config} — type to replace`}
                type="url"
              />
              <Button size="sm" busy={busy} disabled={!draftUrl} onClick={() => onReplaceUrl(draftUrl)}>
                Replace
              </Button>
            </div>
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onToggleActive}>
            {channel.active ? 'Pause channel' : 'Resume channel'}
          </Button>
          <Button size="sm" onClick={onTest}>
            Send test
          </Button>
          <Button size="sm" onClick={onToggleLinks}>
            {linksOpen ? 'Hide monitors' : `Monitors (${links.length})`}
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </div>

        {linksOpen ? (
          <div className="space-y-3 border-t border-[--color-border-subtle] pt-4">
            {links.length === 0 ? (
              <p className="text-sm text-[--color-text-tertiary]">
                Not attached to anything yet — this channel will not alert.
              </p>
            ) : (
              <ul className="space-y-2">
                {links.map((link) => (
                  <li
                    key={link.monitor_id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate-1">
                      {monitorName.get(link.monitor_id) ?? 'Unknown monitor'}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular text-[11px] text-[--color-text-tertiary]">
                        {link.notify_on} · after {link.downtime_threshold_s}s
                      </span>
                      <Button size="sm" variant="ghost" busy={busy} onClick={() => onDetach(link.monitor_id)}>
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <Field label="Attach a monitor">
              <div className="flex gap-2">
                <select
                  className={selectClass}
                  value={pendingMonitor}
                  onChange={(e) => setPendingMonitor(e.target.value)}
                >
                  <option value="">Choose a monitor…</option>
                  {available.map((monitor) => (
                    <option key={monitor.id} value={monitor.id}>
                      {monitor.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  busy={busy}
                  disabled={!pendingMonitor}
                  onClick={() => {
                    onAttach(pendingMonitor);
                    setPendingMonitor('');
                  }}
                >
                  Attach
                </Button>
              </div>
            </Field>

            <p className="text-[11px] text-[--color-text-tertiary]">
              New subscriptions default to {NOTIFY_EVENTS.join(', ')} with no downtime grace period —
              adjust per monitor via the API until the subscription editor ships.
            </p>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
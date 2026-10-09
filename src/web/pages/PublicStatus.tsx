import { useEffect, useState } from 'react';

import { api, ApiError } from '../api.ts';
import type { PublicStatus } from '../types.ts';
import { UptimeBars } from '../components/UptimeBars.tsx';
import {
  Badge,
  ErrorNote,
  Panel,
  Skeleton,
  StatusDot,
  formatUptime,
  statusColor,
  statusLabel,
  timeAgo,
  uptimeTone,
} from '../components/ui.tsx';

/**
 * Public status page.
 *
 * Unauthenticated by design — this is the page you hand to customers. Three
 * rules govern what appears here:
 *   1. Never a monitor URL. Targets routinely contain internal hostnames or
 *      `?token=` query strings.
 *   2. Worst status wins, so the headline never says "Operational" while a
 *      row below is red.
 *   3. No data reads as neutral, never as healthy.
 */
export function PublicStatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await api.publicStatus(90);
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause.message : 'Could not load status');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (loading) return <StatusSkeleton />;
  if (error) return <div className="p-6"><ErrorNote message={error} /></div>;
  if (!status) return <StatusSkeleton />;

  /**
   * Defensive defaults.
   *
   * This page is public and is usually opened from a link with no operator
   * around. A missing array field must degrade to "nothing to show", never to a
   * blank page — a blank status page during an incident is the worst possible
   * failure mode this app has.
   */
  const groups = status.groups ?? [];
  const incidents = status.incidents ?? [];
  const activeIncidents = incidents.filter((incident) => incident.status !== 'resolved');
  const hasMonitors = groups.some((group) => (group.monitors?.length ?? 0) > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-6">
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-xl font-semibold tracking-tight">{status.app_name} status</h1>
        <div className="flex items-center gap-2.5">
          <StatusDot status={hasMonitors ? status.overall : null} size={12} pulse={false} />
          <span className="text-sm font-medium" style={{ color: statusColor(status.overall) }}>
            {hasMonitors ? statusLabel(status.overall) : 'No monitors published'}
          </span>
        </div>
        <p className="text-xs text-[--color-text-tertiary]">
          Updated {timeAgo(status.generated_at)} · refreshed every minute
        </p>
      </header>

      {activeIncidents.length > 0 ? (
        <Panel title="Active incidents" className="border-[--color-degraded]/30">
          <div className="space-y-3">
            {activeIncidents.map((incident) => (
              <article key={incident.id} className="rounded-[--radius-control] border border-[--color-border-subtle] bg-[--color-surface-2] p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusDot status="degraded" size={8} pulse={false} />
                  <h3 className="text-sm font-medium">{incident.title}</h3>
                  <Badge color="var(--color-degraded)">{incident.status}</Badge>
                  <Badge>{incident.impact}</Badge>
                </div>
                <p className="mt-1 text-xs text-[--color-text-tertiary]">
                  Opened {timeAgo(incident.created_at)}
                </p>
                {incident.updates && incident.updates.length > 0 ? (
                  <ol className="mt-3 space-y-2 border-l border-[--color-border-subtle] pl-3">
                    {incident.updates.slice(-4).map((update) => (
                      <li key={update.id} className="text-xs">
                        <span className="text-[--color-text-tertiary]">
                          {timeAgo(update.created_at)} · {update.status}
                        </span>
                        <p className="mt-0.5 text-[--color-text-secondary]">{update.message}</p>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </article>
            ))}
          </div>
        </Panel>
      ) : null}

      {groups.map((group) => (
        <Panel
          key={group.id}
          title={group.name}
          subtitle={group.description ?? undefined}
          actions={<StatusDot status={group.status} size={9} pulse={false} />}
        >
          {(group.monitors?.length ?? 0) === 0 ? (
            <p className="py-4 text-center text-xs text-[--color-text-tertiary]">
              No monitors in this group yet.
            </p>
          ) : (
            <div className="divide-y divide-[--color-border-subtle]">
              {(group.monitors ?? []).map((monitor) => (
                <div
                  key={monitor.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-[180px] flex-1 items-center gap-2.5">
                    <StatusDot status={monitor.status} size={9} />
                    <span className="truncate-1 text-sm">{monitor.name}</span>
                  </div>

                  <div className="w-full sm:w-40">
                    <UptimeBars
                      daily={monitor.daily ?? []}
                      days={status.days}
                      height={20}
                      showAxis={false}
                    />
                  </div>

                  <div className="tabular w-20 text-right text-xs">
                    <span style={{ color: `var(--color-${uptimeTone(monitor.uptime_24h)})` }}>
                      {formatUptime(monitor.uptime_24h)}
                    </span>
                    <p className="text-[--color-text-tertiary]">24h</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      ))}

      {groups.length === 0 ? (
        <Panel>
          <p className="py-8 text-center text-sm text-[--color-text-tertiary]">
            No public status pages yet. Mark a monitor group as public to publish one.
          </p>
        </Panel>
      ) : null}

      <footer className="pt-2 text-center text-[11px] text-[--color-text-tertiary]">
        {status.days}-day history · monitored from the edge · no third-party analytics
      </footer>
    </div>
  );
}

function StatusSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6">
      <Skeleton className="mx-auto h-7 w-56" />
      <Skeleton className="mx-auto h-5 w-40" />
      <Skeleton className="h-56" />
      <Skeleton className="h-72" />
    </div>
  );
}

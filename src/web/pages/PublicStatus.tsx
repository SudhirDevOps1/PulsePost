import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError } from '../api.ts';
import type { PublicGroup, PublicStatus } from '../types.ts';
import { UptimeBars } from '../components/UptimeBars.tsx';
import { usePolling } from '../hooks/usePolling.ts';
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
  return <StatusView days={90} />;
}

/**
 * Single-group public page.
 *
 * Backed by `GET /api/public/status/:slug`, which existed from the start but
 * had no route to reach it — the groups screen could only print the slug as
 * text. Same rendering rules as the aggregate page; only the fetch differs.
 */
export function PublicGroupStatusPage() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <StatusSkeleton />;
  return <StatusView days={90} slug={slug} />;
}

/**
 * Both public pages render from here.
 *
 * `slug` selects the endpoint; everything after the fetch is identical, which
 * is what keeps the "never leak a URL, worst status wins, no data is neutral"
 * rules in exactly one place.
 */
function StatusView({ days, slug }: { days: number; slug?: string }) {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = slug
        ? await api.publicGroupStatus(slug, days)
        : await api.publicStatus(days);
      setStatus(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load status');
    } finally {
      setLoading(false);
    }
  }, [slug, days]);

  useEffect(() => {
    void load();
  }, [load]);

  // Public pages are the most likely to be left open, so this one pauses
  // hardest: no timer at all while the tab is hidden.
  usePolling(load, 60_000);

  const groups = status?.groups ?? [];
  /*
   * Fleet summary, and the defensive defaults, declared BEFORE the early
   * returns rather than after them.
   *
   * The position matters as much as the fallback. `summary` is a `useMemo`, and
   * a hook below a conditional return is a hook that runs conditionally: React
   * throws the moment the branch flips, which here would mean every visitor
   * whose first paint is the skeleton crashes instead of seeing the page.
   *
   * The defaults themselves exist because this page is public and is usually
   * opened from a link with no operator around. A missing array field must
   * degrade to "nothing to show", never to a blank page -- a blank status page
   * during an incident is the worst failure mode this app has.
   */
  const summary = useMemo(() => summarise(groups), [groups]);

  if (loading) return <StatusSkeleton />;
  if (error) return <div className="p-6"><ErrorNote message={error} /></div>;
  if (!status) return <StatusSkeleton />;

  const incidents = status.incidents ?? [];
  const activeIncidents = incidents.filter((incident) => incident.status !== 'resolved');
  const hasMonitors = groups.some((group) => (group.monitors?.length ?? 0) > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-6">
      {/*
        The headline.

        A status page is read in one glance, usually by someone who is already
        worried. Everything here is a number or a bar: the state, how many
        monitors are behind it, and the whole window drawn as one strip. The
        previous version was three lines of centred text and then a list, which
        answered none of the three questions a reader arrives with.
      */}
      <header className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)]">
        <div className="flex flex-col items-center gap-4 px-5 py-6 text-center">
          <div className="flex items-center gap-3">
            <StatusDot status={hasMonitors ? status.overall : null} size={16} pulse={false} />
            <span
              className="text-3xl font-bold tracking-tight"
              style={{ color: statusColor(status.overall) }}
            >
              {hasMonitors ? statusLabel(status.overall) : 'No monitors published'}
            </span>
          </div>

          <p className="-mt-2 text-xs text-[var(--color-text-tertiary)]">
            {status.app_name} · updated {timeAgo(status.generated_at)}
          </p>

          {summary.total > 0 ? (
            <div className="grid w-full grid-cols-3 gap-2 sm:max-w-md">
              <Counter label="Up" value={summary.up} tone="up" />
              <Counter label="Degraded" value={summary.degraded} tone="degraded" />
              <Counter label="Down" value={summary.down} tone="down" />
            </div>
          ) : null}
        </div>

        {/* The window, as one strip. `UptimeBars` renders days it has no data for
            as neutral rather than as healthy, so an empty stretch reads as
            "unknown" instead of quietly inflating the figure above it. */}
        {summary.days.length > 0 ? (
          <div className="border-t border-[var(--color-border-subtle)] px-5 py-4">
            <UptimeBars daily={summary.days} days={status.days} height={38} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-[var(--color-text-tertiary)]">
                Last {status.days} days
                {summary.days.length < status.days
                  ? ` · ${summary.days.length} with data`
                  : ''}
              </span>
              {summary.uptime !== null ? (
                <span className="tabular font-semibold">
                  <span style={{ color: `var(--color-${uptimeTone(summary.uptime)})` }}>
                    {formatUptime(summary.uptime)}
                  </span>
                  <span className="ml-1.5 font-normal text-[var(--color-text-tertiary)]">
                    average daily uptime
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {slug ? (
          <div className="border-t border-[var(--color-border-subtle)] px-5 py-3 text-center">
            <Link
              to="/status"
              className="text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              ← All services
            </Link>
          </div>
        ) : null}
      </header>

      {activeIncidents.length > 0 ? (
        <Panel title="Active incidents" className="border-[var(--color-degraded)]/30">
          <div className="space-y-3">
            {activeIncidents.map((incident) => (
              <article key={incident.id} className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusDot status="degraded" size={8} pulse={false} />
                  <h3 className="text-sm font-medium">{incident.title}</h3>
                  <Badge color="var(--color-degraded)">{incident.status}</Badge>
                  <Badge>{incident.impact}</Badge>
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                  Opened {timeAgo(incident.created_at)}
                </p>
                {incident.updates && incident.updates.length > 0 ? (
                  <ol className="mt-3 space-y-2 border-l border-[var(--color-border-subtle)] pl-3">
                    {incident.updates.slice(-4).map((update) => (
                      <li key={update.id} className="text-xs">
                        <span className="text-[var(--color-text-tertiary)]">
                          {timeAgo(update.created_at)} · {update.status}
                        </span>
                        <p className="mt-0.5 text-[var(--color-text-secondary)]">{update.message}</p>
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
            <p className="py-4 text-center text-xs text-[var(--color-text-tertiary)]">
              No monitors in this group yet.
            </p>
          ) : (
            <div className="divide-y divide-[var(--color-border-subtle)]">
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
                    <p className="text-[var(--color-text-tertiary)]">24h</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      ))}

      {groups.length === 0 ? (
        <Panel>
          <p className="py-8 text-center text-sm text-[var(--color-text-tertiary)]">
            No public status pages yet. Mark a monitor group as public to publish one.
          </p>
        </Panel>
      ) : null}

      <footer className="pt-2 text-center text-[11px] text-[var(--color-text-tertiary)]">
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

/**
 * Fleet-wide figures for the status header.
 *
 * Derived entirely from the `daily` arrays already in the payload, so it costs
 * nothing: no extra query, no extra row read. That matters here more than usual
 * -- this is the most-hit endpoint in the product, because it is the one a
 * customer-facing link points at and it is polled every minute.
 *
 * The uptime figure is the mean of the daily averages, and it is labelled that
 * way in the UI. It is not a check-weighted figure: the payload carries
 * `uptime` per day but not the `total_checks` those percentages came from, and
 * presenting an unweighted mean as "uptime" would be a nicer number than the
 * truth. Days with no data are excluded rather than counted as 100%, which is
 * the same reason `UptimeBars` leaves them blank instead of filling them in.
 */
function summarise(groups: PublicGroup[]): {
  total: number;
  up: number;
  degraded: number;
  down: number;
  days: Array<{ date: string; uptime: number }>;
  uptime: number | null;
} {
  const perDay = new Map<string, { sum: number; n: number }>();
  let total = 0;
  let up = 0;
  let degraded = 0;
  let down = 0;

  for (const group of groups) {
    for (const monitor of group.monitors ?? []) {
      total += 1;
      if (monitor.status === 'up') up += 1;
      else if (monitor.status === 'degraded') degraded += 1;
      else if (monitor.status === 'down') down += 1;

      for (const day of monitor.daily ?? []) {
        const bucket = perDay.get(day.date) ?? { sum: 0, n: 0 };
        bucket.sum += day.uptime;
        bucket.n += 1;
        perDay.set(day.date, bucket);
      }
    }
  }

  const days = [...perDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, bucket]) => ({ date, uptime: bucket.sum / bucket.n }));

  const known = days.map((d) => d.uptime).filter((v): v is number => v !== null);
  const uptime = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : null;

  return { total, up, degraded, down, days, uptime };
}

/** One of the three headline counters. A zero renders muted, not alarming. */
function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'up' | 'degraded' | 'down';
}) {
  const muted = value === 0;
  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-3 py-2.5">
      <div
        className={`text-xl font-bold tabular ${muted ? 'text-[var(--color-text-tertiary)]' : ''}`}
        style={muted ? undefined : { color: `var(--color-${tone})` }}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
        {label}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api.ts';
import type { DailyStatus, EdgeNode, MonitorWithStatus, Overview } from '../types.ts';
import { EdgeMap } from '../components/EdgeMap.tsx';
import { LatencyChart } from '../components/LatencyChart.tsx';
import { MonitorCard } from '../components/MonitorCard.tsx';
import {
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Skeleton,
  StatCard,
  formatMs,
  formatUptime,
  timeAgo,
  uptimeTone,
} from '../components/ui.tsx';

/**
 * Dashboard.
 *
 * Reading order is deliberate: headline numbers, then the geographic picture,
 * then the detail list. An operator opening this at 3am needs "what is broken"
 * in under two seconds, and that answer is in the first row of stat tiles.
 */
export function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [monitors, setMonitors] = useState<MonitorWithStatus[]>([]);
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [checks, setChecks] = useState<import('../types.ts').Check[]>([]);
  const [daily, setDaily] = useState<DailyStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'down' | 'degraded'>('all');

  const load = useCallback(async () => {
    setError(null);
    try {
      // The three list endpoints are independent; run them together.
      const [overviewResult, monitorsResult, edgeResult] = await Promise.all([
        api.overview(),
        api.monitors({ limit: 200, include_uptime: true }),
        api.edge(),
      ]);

      setOverview(overviewResult.overview);
      setMonitors(monitorsResult.monitors);
      setNodes(edgeResult.nodes);

      // Latency history is only meaningful for a single monitor, so it follows
      // whichever one the operator is most likely to care about.
      const focus =
        monitorsResult.monitors.find((m) => m.current_status === 'down') ??
        monitorsResult.monitors[0];

      if (focus) {
        const history = await api.monitorHistory(focus.id, { limit: 120, days: 7 });
        setChecks(history.checks);
        setDaily(history.daily);
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load the dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function toggle(id: string) {
    setMonitors((current) =>
      current.map((m) => (m.id === id ? { ...m, active: !m.active } : m)),
    );
    try {
      await api.toggleMonitor(id);
      void load();
    } catch {
      void load();
    }
  }

  const visible = monitors.filter((monitor) => {
    if (filter === 'all') return true;
    return monitor.current_status === filter;
  });

  const focusMonitor =
    monitors.find((m) => m.current_status === 'down') ?? monitors[0] ?? null;

  if (loading) return <DashboardSkeleton />;

  return (
    <div className="space-y-5">
      {error ? <ErrorNote message={error} onRetry={load} /> : null}

      {/* --- headline --- */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Overall"
          value={overview ? statusWord(overview) : '—'}
          tone={
            overview && overview.down > 0
              ? 'down'
              : overview && overview.degraded > 0
                ? 'degraded'
                : 'up'
          }
          hint={`${overview?.total ?? 0} monitor${overview?.total === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Uptime 24h"
          value={formatUptime(overview?.uptime_24h ?? null)}
          tone={toneOf(overview?.uptime_24h ?? null)}
          hint="weighted across monitors"
        />
        <StatCard
          label="Uptime 90d"
          value={formatUptime(overview?.uptime_90d ?? null)}
          tone={toneOf(overview?.uptime_90d ?? null)}
          hint="from daily rollups"
        />
        <StatCard
          label="Avg latency"
          value={formatMs(overview?.avg_response_time_ms ?? null)}
          tone="accent"
          hint="24 hour mean"
        />
        <StatCard
          label="Incidents"
          value={overview?.active_incidents ?? 0}
          tone={overview && overview.active_incidents > 0 ? 'degraded' : 'neutral'}
          hint={`swept ${timeAgo(overview?.last_sweep_at)}`}
          className="col-span-2 lg:col-span-1"
        />
      </section>

      {/* --- map + latency --- */}
      <section className="grid gap-4 lg:grid-cols-5">
        <Panel
          title="Edge nodes"
          subtitle={`${nodes.length} colo${nodes.length === 1 ? '' : 's'} running checks`}
          className="lg:col-span-3"
          bodyClassName="p-3"
        >
          <EdgeMap nodes={nodes} height={330} />
        </Panel>

        <Panel
          title="Response time"
          subtitle={focusMonitor ? focusMonitor.name : 'no monitor selected'}
          className="lg:col-span-2"
        >
          {focusMonitor ? (
            <>
              <LatencyChart checks={checks} height={190} />
              <div className="mt-3">
                <UptimePreview daily={daily} />
              </div>
            </>
          ) : (
            <EmptyState title="No monitors yet" description="Add one to start collecting data." />
          )}
        </Panel>
      </section>

      {/* --- monitor list --- */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Monitors</h2>
          <div className="flex items-center gap-2">
            <FilterTabs value={filter} onChange={setFilter} counts={monitors} />
            <Button size="sm" variant="primary" onClick={() => undefined}>
              <Link to="/monitors/new">Add monitor</Link>
            </Button>
          </div>
        </div>

        {visible.length === 0 ? (
          <Panel>
            <EmptyState
              title={monitors.length === 0 ? 'No monitors yet' : 'Nothing matches that filter'}
              description={
                monitors.length === 0
                  ? 'Create your first monitor — a simple URL check takes about ten seconds.'
                  : undefined
              }
              action={
                monitors.length === 0 ? (
                  <Link to="/monitors/new">
                    <Button variant="primary">Add monitor</Button>
                  </Link>
                ) : undefined
              }
            />
          </Panel>
        ) : (
          <div className="space-y-2.5">
            {visible.map((monitor) => (
              <MonitorCard key={monitor.id} monitor={monitor} onToggle={toggle} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function UptimePreview({ daily }: { daily: DailyStatus[] }) {
  if (daily.length === 0) {
    return <p className="text-xs text-[--color-text-tertiary]">Daily rollups appear after the first nightly job.</p>;
  }

  const total = daily.reduce((sum, day) => sum + day.total_checks, 0);
  const up = daily.reduce((sum, day) => sum + day.up_checks, 0);
  const uptime = total === 0 ? null : (up / total) * 100;

  return (
    <div className="rounded-[--radius-control] border border-[--color-border-subtle] bg-[--color-surface-2] p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-[--color-text-tertiary]">Daily uptime</span>
        <span
          className="tabular text-sm font-medium"
          style={{ color: `var(--color-${toneOf(uptime)})` }}
        >
          {formatUptime(uptime)}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-[--color-text-tertiary]">
        {daily.length} day{daily.length === 1 ? '' : 's'} · {total} checks
      </p>
    </div>
  );
}

function FilterTabs({
  value,
  onChange,
  counts,
}: {
  value: 'all' | 'down' | 'degraded';
  onChange: (next: 'all' | 'down' | 'degraded') => void;
  counts: MonitorWithStatus[];
}) {
  const options = [
    { key: 'all' as const, label: 'All', count: counts.length },
    { key: 'down' as const, label: 'Down', count: counts.filter((m) => m.current_status === 'down').length },
    {
      key: 'degraded' as const,
      label: 'Degraded',
      count: counts.filter((m) => m.current_status === 'degraded').length,
    },
  ];

  return (
    <div className="flex gap-1 rounded-[--radius-control] border border-[--color-border-subtle] bg-[--color-surface-1] p-0.5">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            value === option.key
              ? 'bg-[--color-surface-3] text-[--color-text-primary]'
              : 'text-[--color-text-tertiary] hover:text-[--color-text-secondary]'
          }`}
        >
          {option.label}
          <span className="tabular ml-1.5 opacity-70">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-[104px]" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Skeleton className="h-[380px] lg:col-span-3" />
        <Skeleton className="h-[380px] lg:col-span-2" />
      </div>
      <div className="space-y-2.5">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[92px]" />
        ))}
      </div>
    </div>
  );
}

function statusWord(overview: Overview): string {
  if (overview.total === 0) return 'No monitors';
  if (overview.down > 0) return 'Outage';
  if (overview.degraded > 0) return 'Degraded';
  return 'Operational';
}

function toneOf(uptime: number | null) {
  if (uptime === null) return 'neutral' as const;
  if (uptime >= 99.9) return 'up' as const;
  if (uptime >= 95) return 'degraded' as const;
  return 'down' as const;
}
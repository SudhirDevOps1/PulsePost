import { Link } from 'react-router-dom';

import type { MonitorWithStatus } from '../types.ts';
import { UptimeStrip } from './UptimeBars.tsx';
import {
  Badge,
  StatusDot,
  formatMs,
  formatUptime,
  timeAgo,
  uptimeTone,
} from './ui.tsx';

/**
 * One monitor in the dashboard list.
 *
 * Layout priority, left to right: is it alive → how reliable → how fast →
 * when did we last hear from it. That ordering means a scan down the list
 * surfaces problems without reading any text.
 */
export function MonitorCard({
  monitor,
  onToggle,
}: {
  monitor: MonitorWithStatus;
  onToggle?: (id: string) => void;
}) {
  const status = monitor.active ? monitor.current_status : 'paused';
  const tone = uptimeTone(monitor.uptime_24h);

  /**
   * Only draw the 90-day strip when there is something to draw. A row of empty
   * placeholder bars reads as "no uptime recorded", which on a brand-new
   * install is true but looks like a fault — better to show nothing.
   */
  const daily = monitor.daily;
  const hasHistory = (daily?.length ?? 0) > 0;

  return (
    <article className="panel group p-4 transition-colors hover:border-[--color-border-strong]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <StatusDot status={status} />
            <Link
              to={`/monitors/${monitor.id}`}
              className="truncate-1 text-sm font-medium text-[--color-text-primary] hover:text-[--color-accent] hover:underline"
            >
              {monitor.name}
            </Link>
            {monitor.kind === 'dsl' ? (
              <Badge color="var(--color-accent)">multi-step</Badge>
            ) : null}
            {!monitor.active ? <Badge>paused</Badge> : null}
          </div>

          <p className="mt-1 truncate-1 text-xs text-[--color-text-tertiary]">
            {monitor.kind === 'dsl' ? 'DSL script' : `${monitor.method} ${redactUrl(monitor.url)}`}
          </p>

          {monitor.last_check?.error_message ? (
            <p className="mt-1.5 line-clamp-2 text-xs" style={{ color: 'var(--color-down)' }}>
              {monitor.last_check.error_message}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-6">
          <Metric label="24h uptime" value={formatUptime(monitor.uptime_24h)} color={`var(--color-${tone})`} />
          <Metric label="Latency" value={formatMs(monitor.last_check?.response_time_ms ?? null)} />
          <div className="hidden w-32 sm:block">
            {hasHistory ? (
              <>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-[--color-text-tertiary]">
                  90 days
                </p>
                <UptimeStrip daily={daily} days={90} />
              </>
            ) : null}
          </div>
          {onToggle ? (
            <button
              type="button"
              onClick={() => onToggle(monitor.id)}
              className="rounded-md px-2 py-1 text-xs text-[--color-text-tertiary] opacity-0 transition-opacity hover:bg-[--color-surface-3] hover:text-[--color-text-primary] group-hover:opacity-100 focus-visible:opacity-100"
              title={monitor.active ? 'Pause monitoring' : 'Resume monitoring'}
            >
              {monitor.active ? 'Pause' : 'Resume'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 text-[11px] text-[--color-text-tertiary]">
        <span>Checked {timeAgo(monitor.last_check?.checked_at)}</span>
        {monitor.last_check?.colo ? <span>· {monitor.last_check.colo}</span> : null}
        <span>· every {formatInterval(monitor.interval_seconds)}</span>
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-[--color-text-tertiary]">{label}</p>
      <p className="tabular mt-0.5 text-sm font-medium" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/**
 * Strip credentials and query strings.
 *
 * Monitor URLs routinely carry API keys (`?token=…`) or embed credentials, and
 * this string is rendered in a shared dashboard list.
 */
export function redactUrl(url: string | null): string {
  if (!url) return '—';
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = parsed.search ? '?…' : '';
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
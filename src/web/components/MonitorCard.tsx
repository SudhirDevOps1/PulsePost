import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { MonitorWithStatus } from '../types.ts';
import { UptimeStrip } from './UptimeBars.tsx';
import {
  Button,
  Sparkline,
  StatusDot,
  formatMs,
  formatUptime,
  inputClass,
  timeAgo,
  uptimeTone,
} from './ui.tsx';

/**
 * One monitor in the dashboard list.
 *
 * Layout priority, left to right: is it alive → how reliable → how fast →
 * when did we last hear from it. Scanning down the list should surface
 * problems without reading any text.
 *
 * A NOTE ON HOVER
 * ---------------
 * An earlier version revealed the pause control with `opacity-0
 * group-hover:opacity-100`. That is unusable on a touch device: there is no
 * hover, so the button was permanently invisible *and* untappable, which meant
 * a paused monitor could not be resumed from a phone at all. The controls are
 * now always rendered and rely on the surrounding row being the target rather
 * than on a hover state to appear.
 */
export function MonitorCard({
  monitor,
  onToggle,
  onRename,
  onDelete,
  busy = false,
}: {
  monitor: MonitorWithStatus;
  onToggle?: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  onDelete?: (monitor: MonitorWithStatus) => void;
  busy?: boolean;
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
  const latency = monitor.latency ?? [];

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(monitor.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function commitRename() {
    const next = draftName.trim();
    // An empty or unchanged name is not a rename. Silently saving "" would
    // leave a nameless row that cannot be identified.
    if (!next || next === monitor.name) {
      setRenaming(false);
      setDraftName(monitor.name);
      return;
    }
    onRename?.(monitor.id, next);
    setRenaming(false);
  }

  return (
    <article className="clay p-5 transition-shadow duration-300 hover:shadow-[var(--shadow-raised)]">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {/* Identity */}
        <div className="min-w-0 flex-1 basis-64">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') {
                    setRenaming(false);
                    setDraftName(monitor.name);
                  }
                }}
                maxLength={120}
                aria-label="Monitor name"
                autoFocus
              />
              <Button size="sm" variant="primary" busy={busy} onClick={commitRename}>
                Save
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setRenaming(false);
                  setDraftName(monitor.name);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot status={status} />
                <Link
                  to={`/monitors/${monitor.id}`}
                  className="truncate-1 text-[15px] font-bold tracking-tight text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent-text)]"
                >
                  {monitor.name}
                </Link>
                {monitor.kind === 'dsl' ? (
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">multi-step</span>
                ) : null}
                {!monitor.active ? (
                  <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                    paused
                  </span>
                ) : null}
              </div>

              <p className="mt-1.5 truncate-1 text-xs font-medium text-[var(--color-text-tertiary)]">
                {monitor.kind === 'dsl' ? 'DSL script' : `${monitor.method} ${redactUrl(monitor.url)}`}
              </p>
            </>
          )}

          {monitor.last_check?.error_message ? (
            <p className="mt-1.5 line-clamp-2 text-xs" style={{ color: 'var(--color-down)' }}>
              {monitor.last_check.error_message}
            </p>
          ) : null}
        </div>

        {/*
          Metrics.
          `basis-full` on small screens so they wrap onto their own row rather
          than being crushed into a narrow column beside the name.
        */}
        <div className="flex w-full basis-full items-end gap-5 sm:w-auto sm:basis-auto">
          <Metric
            label="24h uptime"
            value={formatUptime(monitor.uptime_24h)}
            color={`var(--color-${tone})`}
          />

          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Latency
            </p>
            <div className="mt-1 flex items-center gap-2.5">
              <span className="tabular text-lg font-bold">
                {formatMs(monitor.last_check?.response_time_ms ?? null)}
              </span>
              <Sparkline values={latency} width={76} height={22} />
            </div>
          </div>

          {hasHistory ? (
            <div className="hidden w-32 lg:block">
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                90 days
              </p>
              <UptimeStrip daily={daily} days={90} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Footer: always visible, never hover-gated. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-[var(--color-text-tertiary)]">
          <span>Checked {timeAgo(monitor.last_check?.checked_at)}</span>
          {monitor.last_check?.colo ? <span>· {monitor.last_check.colo}</span> : null}
          <span>· every {formatInterval(monitor.interval_seconds)}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {onToggle ? (
            <Button size="sm" variant="ghost" busy={busy} onClick={() => onToggle(monitor.id)}>
              {monitor.active ? 'Pause' : 'Resume'}
            </Button>
          ) : null}

          {onRename ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || renaming}
              onClick={() => {
                setDraftName(monitor.name);
                setRenaming(true);
              }}
            >
              Rename
            </Button>
          ) : null}

          {onDelete ? (
            confirmingDelete ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  busy={busy}
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDelete(monitor);
                  }}
                >
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            )
          ) : null}
        </div>
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
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-tertiary)]">
        {label}
      </p>
      <p className="tabular mt-1 text-lg font-bold" style={color ? { color } : undefined}>
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
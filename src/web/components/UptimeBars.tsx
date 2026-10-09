import { useMemo } from 'react';

import type { Check, DailyStatus, MonitorStatus } from '../types.ts';
import { formatUptime } from './ui.tsx';

/**
 * Uptime history bar — the familiar status-page strip.
 *
 * Source priority:
 *   1. `daily_status` rollups when they cover the window (cheap, 1 row/day).
 *   2. raw `checks` otherwise, bucketed to one bar per ~2 hours.
 *
 * Deliberately hand-rolled SVG rather than a charting library: this is the most
 * repeated element in the UI, and a bar chart is not worth pulling in Recharts
 * for. It also keeps it dependency-free for the public status page.
 */

const SLOT_WIDTH = 4;
const SLOT_GAP = 2;
const BAR_HEIGHT = 30;

function uptimeToStatus(uptime: number): MonitorStatus {
  if (uptime >= 100) return 'up';
  if (uptime >= 95) return 'degraded';
  return 'down';
}

const FILL: Record<MonitorStatus, string> = {
  up: 'var(--color-up)',
  degraded: 'var(--color-degraded)',
  down: 'var(--color-down)',
};

/** One day of history. Both API shapes normalise to this. */
export interface UptimeDay {
  date: string;
  uptime: number;
}

export function UptimeBars({
  daily,
  checks,
  days = 90,
  height = BAR_HEIGHT,
  showAxis = true,
}: {
  daily?: UptimeDay[];
  checks?: Check[];
  days?: number;
  height?: number;
  showAxis?: boolean;
}) {
  const slots = useMemo(() => buildSlots(daily, checks, days), [daily, checks, days]);

  if (slots.length === 0) {
    return (
      <div className="grid h-[30px] place-items-center rounded bg-[--color-surface-2] text-xs text-[--color-text-tertiary]">
        No history yet — the first check will appear here
      </div>
    );
  }

  const width = slots.length * (SLOT_WIDTH + SLOT_GAP);

  return (
    <div className="w-full">
      <div className="overflow-x-auto pb-1">
        <svg
          width={Math.max(width, 100)}
          height={height}
          viewBox={`0 0 ${Math.max(width, 100)} ${height}`}
          preserveAspectRatio="none"
          className="block"
          role="img"
          aria-label={`Uptime over the last ${days} days`}
        >
          {slots.map((slot, index) => {
            const x = index * (SLOT_WIDTH + SLOT_GAP);
            // No-data days render as a faint outline rather than a colour, so a
            // gap is never mistaken for downtime.
            if (slot === null) {
              return (
                <rect
                  key={index}
                  x={x}
                  y={2}
                  width={SLOT_WIDTH}
                  height={height - 4}
                  rx={1.5}
                  fill="var(--color-surface-3)"
                  opacity={0.5}
                >
                  <title>No data</title>
                </rect>
              );
            }

            const status = uptimeToStatus(slot.uptime);
            return (
              <rect
                key={index}
                className="uptime-bar"
                x={x}
                y={2}
                width={SLOT_WIDTH}
                height={height - 4}
                rx={1.5}
                fill={FILL[status]}
                opacity={0.85}
              >
                <title>{`${slot.date}: ${formatUptime(slot.uptime)}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>

      {showAxis ? (
        <div className="mt-1.5 flex justify-between text-[10px] text-[--color-text-tertiary]">
          <span>{days}d ago</span>
          <span>today</span>
        </div>
      ) : null}
    </div>
  );
}

interface Slot {
  date: string;
  uptime: number;
}

/**
 * Build one slot per day for the window.
 *
 * Degraded is excluded from the up/down split the same way the API does, so the
 * bar and the headline number can never disagree. Raw `checks` are only used as
 * a fallback when no rollups exist yet (a brand-new install).
 */
function buildSlots(
  daily: UptimeDay[] | undefined,
  checks: Check[] | undefined,
  days: number,
): Array<Slot | null> {
  const byDate = new Map<string, number>();

  for (const row of daily ?? []) {
    byDate.set(row.date, row.uptime);
  }

  // If the rollups do not cover the window, derive bars from raw checks so the
  // strip is not blank once any data exists.
  if (byDate.size === 0 && checks && checks.length > 0) {
    const buckets = new Map<string, { up: number; total: number }>();

    for (const check of checks) {
      if (check.status === 'degraded') continue;
      const date = check.checked_at.slice(0, 10);
      const entry = buckets.get(date) ?? { up: 0, total: 0 };
      entry.total += 1;
      if (check.status === 'up') entry.up += 1;
      buckets.set(date, entry);
    }

    for (const [date, entry] of buckets) {
      byDate.set(date, (entry.up / entry.total) * 100);
    }
  }

  /**
   * Adapt the window to the data.
   *
   * A three-day-old install has three days of history. Drawing 90 slots would
   * put 87 empty placeholders in front of the operator, which reads as
   * "broken" rather than "new". So the window starts at the earliest day that
   * actually has data, capped at `days`.
   */
  let span = days;
  const earliest = [...byDate.keys()].sort()[0];

  if (earliest) {
    const ageInDays = Math.floor(
      (Date.now() - new Date(`${earliest}T00:00:00Z`).getTime()) / 86_400_000,
    );
    // +1 so today's slot is always included.
    if (Number.isFinite(ageInDays) && ageInDays + 1 < span) {
      span = Math.max(1, ageInDays + 1);
    }
  }

  const slots: Array<Slot | null> = [];
  const today = new Date();

  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const uptime = byDate.get(date);
    slots.push(uptime === undefined ? null : { date, uptime });
  }

  return slots;
}

/** Compact per-monitor strip used inside list rows. */
export function UptimeStrip({
  daily,
  checks,
  days = 90,
}: {
  daily?: UptimeDay[];
  checks?: Check[];
  days?: number;
}) {
  return <UptimeBars daily={daily} checks={checks} days={days} height={22} showAxis={false} />;
}
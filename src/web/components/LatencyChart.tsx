import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Check } from '../types.ts';
import { formatMs } from './ui.tsx';

/**
 * Response-time chart.
 *
 * Recharts is lazy-loaded by the route, so its ~180 KB gz never touches the
 * initial dashboard payload. The chart is also skipped entirely when there is
 * nothing to plot, which is the common case on a fresh install.
 *
 * `connectNulls` matters: timeouts and network failures produce no latency
 * sample, and without it the line would drop to zero and read as "very fast"
 * rather than "no measurement".
 */

interface Point {
  t: number;
  label: string;
  ms: number | null;
  down: boolean;
}

export function LatencyChart({
  checks,
  height = 160,
  title,
}: {
  checks: Check[];
  height?: number;
  title?: string;
}) {
  const points = useMemo(() => toPoints(checks), [checks]);

  /*
   * Both of these must be computed BEFORE the early return below.
   *
   * A hook that sits after a conditional return is a conditional hook: React
   * compares hook order between renders and throws "rendered fewer hooks than
   * expected" the moment the branch flips. It flips on exactly the transition
   * this chart is built around -- a monitor with no history yet rendering the
   * empty state, then its first check landing and rendering the plot -- so a
   * fresh install would have crashed on its first successful check.
   */
  const span = points.length > 1 ? points[points.length - 1]!.t - points[0]!.t : 0;
  const formatTick = useMemo(() => tickFormatter(span), [span]);

  const hasData = points.some((point) => point.ms !== null);

  if (!hasData) {
    return (
      <div
        className="grid place-items-center rounded-[var(--radius-control)] bg-[var(--color-surface-2)] text-xs text-[var(--color-text-tertiary)]"
        style={{ height }}
      >
        No response times recorded yet
      </div>
    );
  }

  const values = points.map((p) => p.ms).filter((ms): ms is number => ms !== null);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, max);

  return (
    <div>
      {/* Fixed height for the plot only; the stats line below lives outside it
          so it cannot be overlapped by Recharts' SVG. */}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {/*
  `left: 0`, not a negative value.

  A negative left margin pulls the axis out past the edge of the SVG, so
  Recharts still reserves `YAxis width` for it but roughly half of that space
  falls outside the clip region. The result was axis labels with their leading
  digit sheared off -- "136ms" rendered as "36ms". The labels need that width
  *inside* the chart, which means claiming it rather than saving it.
*/}
      <AreaChart data={points} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <defs>
            {/* Gradient keyed to the chart's own accent so it follows theming. */}
            <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-accent)" stopOpacity={0.34} />
              <stop offset="100%" stopColor="var(--chart-accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />

          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatTick}
            tick={{ fill: 'var(--color-text-tertiary)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            domain={[Math.floor(min * 0.85), Math.ceil(max * 1.1)]}
            tick={{ fill: 'var(--color-text-tertiary)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={46}
            tickFormatter={(value: number) => `${Math.round(value)}ms`}
          />

          <Tooltip
            content={<LatencyTooltip />}
            cursor={{ stroke: 'var(--color-border-strong)', strokeWidth: 1 }}
            isAnimationActive={false}
          />

          <Area
            type="monotone"
            dataKey="ms"
            stroke="var(--chart-accent)"
            strokeWidth={1.75}
            fill="url(#latencyFill)"
            connectNulls
            dot={false}
            activeDot={{ r: 3.5, fill: 'var(--chart-accent)', stroke: 'var(--color-surface-0)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--color-text-tertiary)]">
        <span className="tabular">
          min {formatMs(min)} · avg{' '}
          {formatMs(Math.round(values.reduce((a, b) => a + b, 0) / values.length))} · max{' '}
          {formatMs(max)}
          {/* The window, not just the shape of the line inside it. Without this
              the same "avg 83ms" reads as equivalent whether it covers four
              minutes or four days, which is the difference between a blip and a
              regression. */}
          {points.length > 1 ? <span className="font-sans"> · {spanLabel(span)}</span> : null}
        </span>
        {title ? <span className="truncate-1">{title}</span> : null}
      </div>
    </div>
  );
}

function LatencyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Point }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]!.payload;

  return (
    <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs shadow-lg">
      <div className="text-[var(--color-text-tertiary)]">{point.label}</div>
      <div className="tabular mt-0.5 font-medium text-[var(--color-text-primary)]">
        {point.down ? (
          <span style={{ color: 'var(--color-down)' }}>Failed</span>
        ) : (
          formatMs(point.ms)
        )}
      </div>
    </div>
  );
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A duration, sized to its own magnitude.
 *
 * `4m 20s` reads correctly and `4m 20s` for a nine-day window is a lie of
 * omission, so the units escalate instead of truncating: below a day the two
 * largest useful units, above a day only days.
 */
function spanLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Axis labels, chosen to suit how much time the series actually covers.
 *
 * A single fixed format is wrong somewhere. Time-only labels read well over an
 * hour but are meaningless across a week -- four different days all labelled
 * "14:00" -- and, worse, they collide outright on a short window: over ninety
 * seconds, `HH:MM` renders 01:18:00 and 01:18:30 as the identical string
 * "01:18 PM", which is exactly the duplicate-label artefact this axis was
 * rewritten to remove. Seconds are therefore not an optional refinement here,
 * they are the only thing that distinguishes one tick from the next when the
 * whole series fits inside a minute.
 *
 * Formatting to the span means the tick carries exactly as much precision as
 * the range can justify, and no more.
 */
function tickFormatter(span: number): (value: number) => string {
  // Recharts re-renders ticks on every resize, so these are built once per span
  // change rather than once per tick.
  if (span >= 2 * DAY) {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    return (value) => fmt.format(new Date(value));
  }
  if (span >= 12 * HOUR) {
    const fmt = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return (value) => fmt.format(new Date(value));
  }
  if (span >= 10 * 60_000) {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (value) => fmt.format(new Date(value));
  }
  const fmt = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return (value) => fmt.format(new Date(value));
}

/**
 * Oldest-to-newest points.
 *
 * `label` is the tooltip's text, and it is deliberately fuller than an axis
 * tick: a tooltip is opened on one specific point, so it can afford to say the
 * date outright rather than relying on neighbouring ticks for context.
 */
function toPoints(checks: Check[]): Point[] {
  const ordered = [...checks].sort(
    (a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime(),
  );

  // Very long histories make the chart unreadable and slow to render; the
  // recent window is what an operator actually looks at.
  const recent = ordered.slice(-120);

  const span =
    recent.length > 1
      ? new Date(recent[recent.length - 1]!.checked_at).getTime() -
        new Date(recent[0]!.checked_at).getTime()
      : 0;

  // Anything spanning a day boundary needs the date, or the tooltip says the
  // same thing for every point in the series. Seconds earn their place at the
  // other end, where the whole series fits inside a minute.
  const tooltipFormat =
    span >= 12 * HOUR
      ? new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : span >= 10 * 60_000
        ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
        : new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });

  return recent.map((check) => {
    const at = new Date(check.checked_at);
    return {
      t: at.getTime(),
      label: tooltipFormat.format(at),
      ms: check.status === 'down' ? null : check.response_time_ms,
      down: check.status === 'down',
    };
  });
}
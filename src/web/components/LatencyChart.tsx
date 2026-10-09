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
          <AreaChart data={points} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
          <defs>
            {/* Gradient keyed to the chart's own accent so it follows theming. */}
            <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-accent)" stopOpacity={0.34} />
              <stop offset="100%" stopColor="var(--chart-accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />

          <XAxis
            dataKey="label"
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
          {formatMs(Math.round(values.reduce((a, b) => a + b, 0) / values.length))} · max {formatMs(max)}
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

/** Oldest-to-newest points with a short time axis label. */
function toPoints(checks: Check[]): Point[] {
  const ordered = [...checks].sort(
    (a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime(),
  );

  // Very long histories make the chart unreadable and slow to render; the
  // recent window is what an operator actually looks at.
  const recent = ordered.slice(-120);

  return recent.map((check) => ({
    t: new Date(check.checked_at).getTime(),
    label: new Date(check.checked_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    ms: check.status === 'down' ? null : check.response_time_ms,
    down: check.status === 'down',
  }));
}
import type { ReactNode } from 'react';

import type { MonitorStatus } from '../types.ts';

/**
 * UI primitives.
 *
 * Grouped into one module rather than one file per component: each piece is
 * under 40 lines, and splitting them would add seven imports to every screen
 * without buying any abstraction.
 */

const STATUS_COLOR: Record<MonitorStatus | 'paused' | 'unknown', string> = {
  up: 'var(--color-up)',
  degraded: 'var(--color-degraded)',
  down: 'var(--color-down)',
  paused: 'var(--color-paused)',
  unknown: 'var(--color-text-tertiary)',
};

export function statusColor(status: MonitorStatus | 'paused' | null | undefined): string {
  if (!status) return STATUS_COLOR.unknown;
  return STATUS_COLOR[status] ?? STATUS_COLOR.unknown;
}

export function statusLabel(status: MonitorStatus | 'paused' | null | undefined): string {
  if (!status) return 'Unknown';
  if (status === 'up') return 'Operational';
  if (status === 'degraded') return 'Degraded';
  if (status === 'down') return 'Down';
  return 'Paused';
}

/**
 * Status indicator.
 *
 * Only `down` and `degraded` pulse — a heartbeat animation on healthy services
 * would be pure noise across a list of 20 monitors.
 */
export function StatusDot({
  status,
  size = 10,
  pulse = true,
  title,
}: {
  status: MonitorStatus | 'paused' | null | undefined;
  size?: number;
  pulse?: boolean;
  title?: string;
}) {
  const color = statusColor(status);
  const shouldPulse = pulse && (status === 'down' || status === 'degraded');

  return (
    <span
      className={`relative inline-grid place-items-center ${shouldPulse ? 'status-pulse' : ''}`}
      style={{ width: size, height: size, color }}
      title={title ?? statusLabel(status)}
      aria-label={statusLabel(status)}
      role="img"
    >
      <span
        className="block rounded-full"
        style={{ width: size, height: size, background: color }}
      />
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title || actions ? (
        <header className="panel-header">
          <div className="min-w-0">
            {title ? <h2 className="panel-title">{title}</h2> : null}
            {subtitle ? <p className="panel-subtitle mt-1">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`p-5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/**
 * Headline metric.
 *
 * `tone` tints the value, which is how a bad number reads as bad without
 * needing an icon or extra chrome.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'up' | 'degraded' | 'down' | 'accent';
  icon?: ReactNode;
  className?: string;
}) {
  const toneColor =
    tone === 'neutral'
      ? 'var(--color-text-primary)'
      : tone === 'accent'
        ? 'var(--color-accent)'
        : STATUS_COLOR[tone];

  return (
    <div className={`panel p-5 ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="panel-subtitle truncate-1">{label}</p>
        {icon ? <span className="shrink-0 text-[var(--color-text-tertiary)]">{icon}</span> : null}
      </div>
      <p className="tabular mt-2.5 text-3xl font-bold tracking-tight" style={{ color: toneColor }}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-xs font-medium text-[var(--color-text-tertiary)]">{hint}</p> : null}
    </div>
  );
}

export function Badge({
  children,
  color,
  subtle = true,
}: {
  children: ReactNode;
  color?: string;
  subtle?: boolean;
}) {
  const tint = color ?? 'var(--color-text-secondary)';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-3 py-1.5 text-xs font-bold"
      style={
        subtle
          ? {
              color: tint,
              // A clay pill: the colour tints the surface and the shadow gives
              // it volume, so a badge reads as a soft object rather than a
              // flat label.
              background: `color-mix(in srgb, ${tint} 13%, var(--color-surface-1))`,
              boxShadow: `var(--shadow-pill), inset 0 0 0 1px color-mix(in srgb, ${tint} 22%, transparent)`,
            }
          : { color: 'var(--color-on-accent)', background: tint, boxShadow: 'var(--shadow-pill)' }
      }
    >
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * Button.
 *
 * Three separate feedback channels, because a button that only changes colour
 * feels dead when the finger covers it:
 *   - `:active` scale  — instantaneous, under the finger
 *   - `is-pending`     — held for the whole request, not just the mousedown
 *   - spinner          — says work is happening, not that it finished
 *
 * `busy` maps to `is-pending` rather than replacing the label, so the button
 * does not change width mid-click.
 */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  busy = false,
  className = '',
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  busy?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  const sizing =
    size === 'sm' ? 'px-4 py-2 text-xs rounded-[var(--radius-pill)]' : 'px-5 py-2.5 text-sm rounded-[var(--radius-pill)]';

  const variants: Record<ButtonVariant, string> = {
    // Primary is a solid clay block: the inner shadows are what make it look
    // moulded rather than painted.
    primary:
      'bg-[var(--color-accent)] text-[var(--color-on-accent)] font-bold hover:brightness-105 shadow-[var(--shadow-pill)]',
    // Secondary is the same shape in the card colour, so it sits on a clay
    // surface without looking like a hole.
    secondary:
      'bg-[var(--color-surface-1)] text-[var(--color-text-primary)] font-semibold shadow-[var(--shadow-pill)] hover:bg-[var(--color-surface-2)]',
    ghost:
      'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] font-semibold shadow-[var(--shadow-inset)] hover:text-[var(--color-text-primary)]',
    danger:
      'bg-[var(--color-surface-1)] text-[var(--color-down)] font-bold shadow-[var(--shadow-pill)] hover:bg-[var(--color-down)]/10',
  };

  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      data-busy={busy ? '' : undefined}
      className={`pressable inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${sizing} ${variants[variant]} ${className}`}
    >
      {busy ? <Spinner size={14} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Placeholder block used while data loads. Avoids layout shift when replaced. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-[var(--color-text-primary)]">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-[var(--color-text-tertiary)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="clay flex items-start justify-between gap-3 px-4 py-3 text-sm font-semibold"
      style={{ color: 'var(--color-down)' }}
    >
      <span className="min-w-0">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="pressable shrink-0 rounded-[var(--radius-pill)] px-3 py-1 text-xs underline underline-offset-2 hover:opacity-80"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * Clay field.
 *
 * Inputs are the one place clay is *pressed* rather than raised, so the label
 * sits above a well the control is sunk into. The inner shadows are mirrored
 * relative to a raised shape — light from the lower right — which is what makes
 * the hole read as a hole.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-2 ${className}`}>
      <span className="text-xs font-bold text-[var(--color-text-secondary)]">{label}</span>
      {children}
      {error ? (
        <span className="text-xs font-semibold text-[var(--color-down)]">{error}</span>
      ) : hint ? (
        <span className="text-xs font-medium text-[var(--color-text-tertiary)]">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm font-medium text-[var(--color-text-primary)] outline-none transition-shadow placeholder:text-[var(--color-text-tertiary)] placeholder:font-normal shadow-[var(--shadow-inset)] focus:shadow-[var(--shadow-inset)] focus:ring-2 focus:ring-[var(--color-accent)]/45';

export const selectClass = `${inputClass} appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%2256648a%22 stroke-width=%222.5%22 stroke-linecap=%22round%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-[length:18px] bg-[right_0.9rem_center] bg-no-repeat pr-11`;

/**
 * Uptime percentage.
 *
 * Colour thresholds are intentionally harsh: 99.9% still renders as a warning
 * because at a 5-minute cadence that is roughly four failed checks a month.
 */
export function formatUptime(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function uptimeTone(value: number | null | undefined): MonitorStatus | 'unknown' {
  if (value === null || value === undefined) return 'unknown';
  if (value >= 99.9) return 'up';
  if (value >= 95) return 'degraded';
  return 'down';
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

/** Relative time, e.g. "12s ago". Falls back to a date beyond a week. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'never';

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * Sparkline.
 *
 * A ~20-point latency trace drawn inline. Not a chart component: no axes, no
 * grid, no tooltip — at this size the shape *is* the information, and anything
 * more would cost more pixels than it explains. Recharts would also drag a
 * ~300 KB chunk into the dashboard list, which defeats the point of having a
 * lightweight alternative.
 *
 * Failures are not coloured separately here. `avg_response_time_ms` is null on a
 * failed check, so those samples become gaps in the line rather than dips to
 * zero — a dip would read as "very fast", which is the opposite of the truth.
 * The uptime bars beside it are what carry failure state.
 */
export function Sparkline({
  values,
  width = 88,
  height = 24,
  className = '',
}: {
  values: Array<number | null>;
  width?: number;
  height?: number;
  className?: string;
}) {
  const points = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (points.length < 2) {
    // A flat line through two points would imply a measurement that does not
    // exist. Say nothing instead of drawing something plausible.
    return <span className={`inline-block text-[11px] text-[var(--color-text-tertiary)] ${className}`}>—</span>;
  }

  const max = Math.max(...points);
  const min = Math.min(...points);
  // Guard against a zero range: every sample identical would otherwise divide
  // by zero and produce NaN coordinates, which render as nothing at all.
  const range = max - min || 1;

  const step = width / (values.length - 1);
  const y = (value: number) => height - 2 - ((value - min) / range) * (height - 4);

  const segments: string[] = [];
  let current = '';
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // Gap in the data. Lift the pen so the line does not imply a connection
      // across a missing sample.
      if (current) segments.push(current);
      current = '';
      continue;
    }
    const command = current === '' ? 'M' : 'L';
    current += `${command}${(index * step).toFixed(1)},${y(value).toFixed(1)}`;
  }
  if (current) segments.push(current);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
      role="presentation"
    >
      {segments.map((d, index) => (
        <path
          key={index}
          d={d}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
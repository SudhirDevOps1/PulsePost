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
            {subtitle ? <p className="panel-subtitle mt-0.5">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
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
    <div className={`panel p-4 ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="panel-subtitle truncate-1">{label}</p>
        {icon ? <span className="shrink-0 text-[--color-text-tertiary]">{icon}</span> : null}
      </div>
      <p className="tabular mt-2 text-2xl font-semibold tracking-tight" style={{ color: toneColor }}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-[--color-text-tertiary]">{hint}</p> : null}
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
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={
        subtle
          ? { color: tint, background: `color-mix(in srgb, ${tint} 14%, transparent)` }
          : { color: 'var(--color-surface-0)', background: tint }
      }
    >
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

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
  const sizing = size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm';

  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-[--color-accent] text-[--color-surface-0] hover:opacity-90 font-medium',
    secondary:
      'border border-[--color-border-subtle] bg-[--color-surface-2] text-[--color-text-primary] hover:bg-[--color-surface-3]',
    ghost: 'text-[--color-text-secondary] hover:bg-[--color-surface-2] hover:text-[--color-text-primary]',
    danger: 'border border-[--color-down]/40 text-[--color-down] hover:bg-[--color-down]/10',
  };

  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-[--radius-control] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${variants[variant]} ${className}`}
    >
      {busy ? <Spinner size={13} /> : null}
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
      <p className="text-sm font-medium text-[--color-text-primary]">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-[--color-text-tertiary]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-[--radius-control] border border-[--color-down]/35 bg-[--color-down]/10 px-3 py-2.5 text-sm text-[--color-down]"
    >
      <span className="min-w-0">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 underline underline-offset-2 hover:opacity-80"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

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
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-[--color-text-secondary]">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-[--color-down]">{error}</span>
      ) : hint ? (
        <span className="text-xs text-[--color-text-tertiary]">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-[--radius-control] border border-[--color-border-subtle] bg-[--color-surface-2] px-3 py-2 text-sm text-[--color-text-primary] outline-none transition-colors placeholder:text-[--color-text-tertiary] focus:border-[--color-accent]';

export const selectClass = `${inputClass} appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2397a5bd%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-9`;

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
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, ApiError } from '../api.ts';
import type { Check, DailyStatus, Monitor, MonitorWithStatus } from '../types.ts';
import { EdgeMap } from '../components/EdgeMap.tsx';
import { LatencyChart } from '../components/LatencyChart.tsx';
import { UptimeBars } from '../components/UptimeBars.tsx';
import {
  MonitorForm,
  emptyValues,
  fieldErrorsFrom,
  toPayload,
  valuesFrom,
  type MonitorFormValues,
} from '../components/MonitorForm.tsx';
import { redactUrl } from '../components/MonitorCard.tsx';
import {
  Badge,
  Button,
  ErrorNote,
  Panel,
  Skeleton,
  StatusDot,
  formatMs,
  formatUptime,
  statusLabel,
  timeAgo,
  uptimeTone,
} from '../components/ui.tsx';

/** Create a monitor. */
export function NewMonitorPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState<MonitorFormValues>(emptyValues());
  const [groups, setGroups] = useState<import('../types.ts').MonitorGroup[]>([]);

  useEffect(() => {
    void api.groups().then((r) => setGroups(r.groups ?? [])).catch(() => undefined);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(form: MonitorFormValues) {
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const payload = toPayload(form);
      const { monitor } = await api.createMonitor(payload);
      navigate(`/monitors/${monitor.id}`, { replace: true });
    } catch (cause) {
      setFieldErrors(fieldErrorsFrom(cause));
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Could not create the monitor',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Add monitor</h1>
        <p className="mt-1 text-sm text-[--color-text-tertiary]">
          A simple URL check covers most cases. Switch to a multi-step script to monitor an
          authenticated flow.
        </p>
      </div>

      <Panel>
        <MonitorForm
          initial={values}
          busy={busy}
          groups={groups}
          error={error}
          fieldErrors={fieldErrors}
          submitLabel="Create monitor"
          onSubmit={(next) => {
            setValues(next);
            void submit(next);
          }}
          onCancel={() => navigate('/')}
        />
      </Panel>
    </div>
  );
}

/** Monitor detail: live status, history, and inline editing. */
export function MonitorDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [status, setStatus] = useState<MonitorWithStatus | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [daily, setDaily] = useState<DailyStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [groups, setGroups] = useState<import('../types.ts').MonitorGroup[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const history = await api.monitorHistory(id, { limit: 200, days: 90 });
      const list = await api.monitors({ limit: 200 });
      setChecks(history.checks);
      setDaily(history.daily);
      setStatus(list.monitors.find((m) => m.id === id) ?? null);
      setMonitor((current) => current ?? list.monitors.find((m) => m.id === id) ?? null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load this monitor');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.groups().then((r) => setGroups(r.groups ?? [])).catch(() => undefined);
  }, []);

  async function runNow() {
    setRunning(true);
    try {
      await api.runCheck(id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Check failed');
    } finally {
      setRunning(false);
    }
  }

  async function save(form: MonitorFormValues) {
    setBusy(true);
    setError(null);
    try {
      const { monitor: updated } = await api.updateMonitor(id, toPayload(form));
      setMonitor(updated);
      setEditing(false);
      void load();
    } catch (cause) {
      setFieldErrors(fieldErrorsFrom(cause));
      setError(cause instanceof ApiError ? cause.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${monitor?.name}"? Its history is removed too.`)) return;
    setBusy(true);
    try {
      await api.deleteMonitor(id);
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Skeleton className="h-[420px]" />;
  if (!monitor) return <ErrorNote message={error ?? 'Monitor not found'} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/" className="text-xs text-[--color-text-tertiary] hover:text-[--color-text-secondary]">
            ← Dashboard
          </Link>
          <div className="mt-1 flex items-center gap-2.5">
            <StatusDot status={status?.current_status ?? 'paused'} />
            <h1 className="truncate-1 text-lg font-semibold tracking-tight">{monitor.name}</h1>
            <Badge color={statusColorOf(status?.current_status)}>
              {statusLabel(status?.current_status)}
            </Badge>
          </div>
          <p className="mt-1 truncate-1 text-xs text-[--color-text-tertiary]">
            {monitor.kind === 'dsl' ? 'Multi-step script' : `${monitor.method} ${redactUrl(monitor.url)}`}
          </p>
        </div>

        <div className="flex gap-2">
          <Button size="sm" busy={running} onClick={runNow}>
            Run check
          </Button>
          <Button size="sm" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button size="sm" variant="danger" busy={busy} onClick={remove}>
            Delete
          </Button>
        </div>
      </div>

      {error ? <ErrorNote message={error} /> : null}

      {editing ? (
        <Panel title="Edit monitor">
          <MonitorForm
            initial={valuesFrom(monitor)}
            busy={busy}
            groups={groups}
            error={null}
            fieldErrors={fieldErrors}
            submitLabel="Save changes"
            onSubmit={(form) => void save(form)}
          />
        </Panel>
      ) : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel>
          <Metric label="24h uptime" value={formatUptime(status?.uptime_24h ?? null)} />
        </Panel>
        <Panel>
          <Metric label="90d uptime" value={formatUptime(status?.uptime_90d ?? null)} />
        </Panel>
        <Panel>
          <Metric
            label="Last latency"
            value={formatMs(status?.last_check?.response_time_ms ?? null)}
          />
        </Panel>
        <Panel>
          <Metric label="Last check" value={timeAgo(status?.last_check?.checked_at)} />
        </Panel>
      </section>

      <Panel title="Response time" subtitle="Most recent 120 checks">
        <LatencyChart checks={checks} height={200} title={monitor.name} />
      </Panel>

      <Panel title="Uptime" subtitle="90 days">
        <UptimeBars
          daily={daily.map((d) => ({ date: d.date, uptime: d.total_checks ? (d.up_checks / d.total_checks) * 100 : 100 }))}
          checks={checks}
          days={90}
        />
      </Panel>

      <Panel title="Configuration">
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <Row label="Kind" value={monitor.kind} />
          <Row label="Interval" value={`${monitor.interval_seconds}s`} />
          <Row label="Timeout" value={`${monitor.timeout_ms}ms`} />
          <Row label="Retries" value={String(monitor.retries)} />
          <Row label="Expected status" value={`${monitor.expected_status_min ?? 200}–${monitor.expected_status_max ?? 299}`} />
          <Row label="Follow redirects" value={monitor.follow_redirects ? 'yes' : 'no'} />
          <Row label="Warn above" value={monitor.latency_warn_ms ? `${monitor.latency_warn_ms}ms` : '—'} />
          <Row label="Fail above" value={monitor.latency_fail_ms ? `${monitor.latency_fail_ms}ms` : '—'} />
        </dl>
      </Panel>

      {monitor.script ? (
        <Panel title="Check script">
          <pre className="max-h-80 overflow-auto rounded-[--radius-control] bg-[--color-surface-2] p-3 font-mono text-[11px] leading-relaxed text-[--color-text-secondary]">
            {monitor.script}
          </pre>
        </Panel>
      ) : null}

      <ColoHistory checks={checks} />
    </div>
  );
}

/** Which colos have reported for this monitor. */
function ColoHistory({ checks }: { checks: Check[] }) {
  const byColo = new Map<string, { count: number; failures: number }>();

  for (const check of checks) {
    if (!check.colo) continue;
    const entry = byColo.get(check.colo) ?? { count: 0, failures: 0 };
    entry.count += 1;
    if (check.status === 'down') entry.failures += 1;
    byColo.set(check.colo, entry);
  }

  if (byColo.size === 0) return null;

  return (
    <Panel title="Edge origins" subtitle="Colos that executed this check recently">
      <div className="flex flex-wrap gap-2">
        {[...byColo.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([colo, stats]) => (
            <span
              key={colo}
              className="inline-flex items-center gap-2 rounded-lg border border-[--color-border-subtle] bg-[--color-surface-2] px-2.5 py-1.5 text-xs"
            >
              <span
                className="size-1.5 rounded-full"
                style={{
                  background:
                    stats.failures > 0
                      ? 'var(--color-down)'
                      : stats.failures === 0
                        ? 'var(--color-up)'
                        : 'var(--color-degraded)',
                }}
              />
              <span className="font-medium">{colo}</span>
              <span className="tabular text-[--color-text-tertiary]">{stats.count}</span>
            </span>
          ))}
      </div>
    </Panel>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-[--color-text-tertiary]">{label}</p>
      <p className="tabular mt-1 text-lg font-medium">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-[--color-border-subtle] pb-1.5">
      <dt className="text-[--color-text-tertiary]">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  );
}

function statusColorOf(status: string | null | undefined): string {
  if (status === 'down') return 'var(--color-down)';
  if (status === 'degraded') return 'var(--color-degraded)';
  return 'var(--color-up)';
}

export { uptimeTone, EdgeMap };
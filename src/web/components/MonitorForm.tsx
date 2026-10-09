import { useState } from 'react';

import { ApiError } from '../api.ts';
import type { Monitor, MonitorGroup } from '../types.ts';
import { Button, ErrorNote, Field, inputClass, selectClass } from './ui.tsx';

/**
 * Create / edit form for a monitor.
 *
 * Deliberately shows only the fields that matter for a simple HTTP check and
 * keeps the multi-step DSL behind a disclosure — the original Pingflare made
 * the script the *only* mode, which made the common case needlessly painful.
 */

type Kind = 'http' | 'dsl';

export interface MonitorFormValues {
  name: string;
  kind: Kind;
  url: string;
  method: string;
  headers: string;
  body: string;
  script: string;
  interval_seconds: number;
  timeout_ms: number;
  retries: number;
  follow_redirects: boolean;
  group_id: string;
  expected_status_min: string;
  expected_status_max: string;
  latency_warn_ms: string;
  latency_fail_ms: string;
}

export function emptyValues(): MonitorFormValues {
  return {
    name: '',
    kind: 'http',
    url: '',
    method: 'GET',
    headers: '',
    body: '',
    script: '',
    interval_seconds: 300,
    timeout_ms: 10_000,
    retries: 0,
    follow_redirects: true,
    group_id: '',
    expected_status_min: '',
    expected_status_max: '',
    latency_warn_ms: '',
    latency_fail_ms: '',
  };
}

export function valuesFrom(monitor: Monitor): MonitorFormValues {
  return {
    name: monitor.name,
    kind: monitor.kind,
    url: monitor.url ?? '',
    method: monitor.method,
    headers: monitor.headers ? prettyJson(monitor.headers) : '',
    body: monitor.body ?? '',
    script: monitor.script ? prettyJson(monitor.script) : '',
    interval_seconds: monitor.interval_seconds,
    timeout_ms: monitor.timeout_ms,
    retries: monitor.retries,
    follow_redirects: monitor.follow_redirects,
    group_id: monitor.group_id ?? '',
    expected_status_min: monitor.expected_status_min?.toString() ?? '',
    expected_status_max: monitor.expected_status_max?.toString() ?? '',
    latency_warn_ms: monitor.latency_warn_ms?.toString() ?? '',
    latency_fail_ms: monitor.latency_fail_ms?.toString() ?? '',
  };
}

export function MonitorForm({
  initial,
  groups = [],
  busy,
  error,
  fieldErrors,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: MonitorFormValues;
  groups?: MonitorGroup[];
  busy: boolean;
  error: string | null;
  fieldErrors?: Record<string, string>;
  submitLabel: string;
  onSubmit: (values: MonitorFormValues) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDsl, setShowDsl] = useState(initial.kind === 'dsl');

  const set = <K extends keyof MonitorFormValues>(key: K, value: MonitorFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const isDsl = values.kind === 'dsl';

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {error ? <ErrorNote message={error} /> : null}

      <Field label="Name" error={fieldErrors?.name}>
        <input
          className={inputClass}
          value={values.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Marketing site"
          maxLength={120}
          required
        />
      </Field>

      <div className="flex gap-2" role="group" aria-label="Monitor type">
        {(['http', 'dsl'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              set('kind', kind);
              setShowDsl(kind === 'dsl');
            }}
            className={`flex-1 rounded-[var(--radius-control)] border px-3 py-2 text-sm transition-colors ${
              values.kind === kind
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text-primary)]'
                : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]'
            }`}
          >
            {kind === 'http' ? 'Simple request' : 'Multi-step script'}
          </button>
        ))}
      </div>

      {isDsl ? (
        <>
          <Field
            label="Check script"
            hint='JSON with a "steps" array. Use ${var} to pass values between steps.'
            error={fieldErrors?.script}
          >
            <textarea
              className={`${inputClass} min-h-[220px] font-mono text-xs`}
              value={values.script}
              onChange={(e) => set('script', e.target.value)}
              spellCheck={false}
              placeholder={DSL_PLACEHOLDER}
              required
            />
          </Field>
          <details className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3">
            <summary className="cursor-pointer text-xs text-[var(--color-text-secondary)]">
              Show example
            </summary>
            <pre className="mt-2 overflow-x-auto text-[11px] text-[var(--color-text-tertiary)]">
              {DSL_PLACEHOLDER}
            </pre>
          </details>
        </>
      ) : (
        <>
          <div className="flex gap-2">
            <Field label="Method" className="w-28">
              <select
                className={selectClass}
                value={values.method}
                onChange={(e) => set('method', e.target.value)}
              >
                {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="URL" className="flex-1" error={fieldErrors?.url}>
              <input
                className={inputClass}
                type="url"
                value={values.url}
                onChange={(e) => set('url', e.target.value)}
                placeholder="https://example.com/health"
                required
              />
            </Field>
          </div>

          <Field
            label="Group"
            hint="A group marked public also appears on your status page."
            error={fieldErrors?.group_id}
          >
            <select
              className={selectClass}
              value={values.group_id}
              onChange={(e) => set('group_id', e.target.value)}
            >
              <option value="">Ungrouped</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                  {group.is_public ? ' (public)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={values.follow_redirects}
              onChange={(e) => set('follow_redirects', e.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Follow redirects (each hop is re-checked for safety)
          </label>

          {!showAdvanced ? (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="text-xs text-[var(--color-accent-text)] hover:underline"
            >
              Advanced options
            </button>
          ) : null}
        </>
      )}

      {showAdvanced ? (
        <div className="grid gap-3 rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3 sm:grid-cols-2">
          <Field label="Interval (seconds)" hint="Minimum 60 (Cloudflare cron limit)">
            <input
              className={inputClass}
              type="number"
              min={60}
              max={86400}
              value={values.interval_seconds}
              onChange={(e) => set('interval_seconds', Number(e.target.value))}
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              className={inputClass}
              type="number"
              min={1000}
              max={60000}
              step={500}
              value={values.timeout_ms}
              onChange={(e) => set('timeout_ms', Number(e.target.value))}
            />
          </Field>
          <Field label="Retries" hint="Only transport failures are retried">
            <input
              className={inputClass}
              type="number"
              min={0}
              max={3}
              value={values.retries}
              onChange={(e) => set('retries', Number(e.target.value))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Status min" error={fieldErrors?.expected_status_min}>
              <input
                className={inputClass}
                type="number"
                min={100}
                max={599}
                placeholder="200"
                value={values.expected_status_min}
                onChange={(e) => set('expected_status_min', e.target.value)}
              />
            </Field>
            <Field label="Status max" error={fieldErrors?.expected_status_max}>
              <input
                className={inputClass}
                type="number"
                min={100}
                max={599}
                placeholder="299"
                value={values.expected_status_max}
                onChange={(e) => set('expected_status_max', e.target.value)}
              />
            </Field>
          </div>
          <Field label="Warn above (ms)" hint="Marks the check as degraded">
            <input
              className={inputClass}
              type="number"
              min={1}
              placeholder="800"
              value={values.latency_warn_ms}
              onChange={(e) => set('latency_warn_ms', e.target.value)}
            />
          </Field>
          <Field label="Fail above (ms)" hint="Marks the check as down">
            <input
              className={inputClass}
              type="number"
              min={1}
              placeholder="3000"
              value={values.latency_fail_ms}
              onChange={(e) => set('latency_fail_ms', e.target.value)}
            />
          </Field>

          {!isDsl ? (
            <Field
              label="Headers (JSON)"
              className="sm:col-span-2"
              hint='e.g. { "Authorization": "Bearer …" } — stored and replayed on every check'
              error={fieldErrors?.headers}
            >
              <textarea
                className={`${inputClass} min-h-[80px] font-mono text-xs`}
                value={values.headers}
                onChange={(e) => set('headers', e.target.value)}
                spellCheck={false}
                placeholder='{ "Accept": "application/json" }'
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" busy={busy}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Map server field-level validation issues onto form keys. */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.field] = issue.message;
  return out;
}

/** Build the API payload from form values. */
export function toPayload(values: MonitorFormValues): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: values.name,
    kind: values.kind,
    interval_seconds: Number(values.interval_seconds),
    timeout_ms: Number(values.timeout_ms),
    retries: Number(values.retries),
    follow_redirects: values.follow_redirects,

    group_id: values.group_id ? values.group_id : null,
  };

  const optionalNumber = (value: string) =>
    value.trim() === '' ? null : Number.parseInt(value, 10);

  if (values.kind === 'dsl') {
    base.script = values.script.trim();
  } else {
    base.url = values.url.trim();
    base.method = values.method;
    base.follow_redirects = values.follow_redirects;
    if (values.headers.trim()) {
      try {
        base.headers = JSON.parse(values.headers);
      } catch {
        throw new Error('Headers must be valid JSON');
      }
    }
    base.expected_status_min = optionalNumber(values.expected_status_min);
    base.expected_status_max = optionalNumber(values.expected_status_max);
    base.latency_warn_ms = optionalNumber(values.latency_warn_ms);
    base.latency_fail_ms = optionalNumber(values.latency_fail_ms);
  }

  return base;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

const DSL_PLACEHOLDER = `{
  "steps": [
    {
      "name": "login",
      "request": { "method": "POST", "url": "https://api.example.com/login" },
      "extract": { "token": "json.token" }
    },
    {
      "name": "profile",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/me",
        "headers": { "Authorization": "Bearer \${token}" }
      },
      "assert": [
        { "check": "status", "equals": 200 },
        { "check": "json.id", "greaterThan": 0, "severity": "down" }
      ]
    }
  ]
}`;
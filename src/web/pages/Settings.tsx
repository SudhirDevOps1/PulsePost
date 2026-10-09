import { useState } from 'react';

import { api, ApiError } from '../api.ts';
import type { HealthReport, SessionUser } from '../types.ts';
import { useToast } from '../components/Toast.tsx';
import {
  Button,
  ErrorNote,
  Field,
  Panel,
  inputClass,
  statusColor,
  statusLabel,
} from '../components/ui.tsx';

/**
 * Personal settings and instance health.
 *
 * Two things live here that had no home before: the signed-in user could not
 * change their own name, email or password from anywhere in the product, and
 * `GET /api/health` had no consumer at all — useful precisely when something
 * is wrong and you want to know whether it is you or the database.
 */

export function SettingsPage({ user, onUserChange }: { user: SessionUser; onUserChange: (u: SessionUser) => void }) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-[var(--color-text-tertiary)]">Your account, and the health of this instance.</p>
      </header>

      <ProfilePanel user={user} onUserChange={onUserChange} />
      <PasswordPanel />
      <HealthPanel />
    </div>
  );
}

function ProfilePanel({
  user,
  onUserChange,
}: {
  user: SessionUser;
  onUserChange: (user: SessionUser) => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const dirty = name !== user.name || email !== user.email;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateProfile({ name, email });
      onUserChange(result.user);
      toast.success('Profile saved');
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'Could not save the profile';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Profile">
      <div className="space-y-4">
        {error ? <ErrorNote message={error} /> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Email">
            <input
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
            />
          </Field>
        </div>

        <div className="flex gap-2">
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
            Save changes
          </Button>
          {dirty ? (
            <Button
              onClick={() => {
                setName(user.name);
                setEmail(user.email);
                setError(null);
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function PasswordPanel() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 12 && !mismatch;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword({ current_password: current, new_password: next });
      // The server kills every other session on a password change, so the
      // fields are cleared rather than left to be resubmitted by reflex.
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Password changed. Other sessions were signed out.');
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'Could not change the password';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Password" subtitle="At least 12 characters with upper, lower, a number and a symbol.">
      <div className="space-y-4">
        {error ? <ErrorNote message={error} /> : null}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Current">
            <input
              className={inputClass}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </Field>
          <Field label="New">
            <input
              className={inputClass}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm" error={mismatch ? 'Passwords do not match' : undefined}>
            <input
              className={inputClass}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </Field>
        </div>

        <Button variant="primary" busy={busy} disabled={!canSubmit} onClick={() => void submit()}>
          Change password
        </Button>
      </div>
    </Panel>
  );
}

function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.health());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not reach the health endpoint');
      setReport(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Instance health"
      actions={
        <Button size="sm" onClick={() => void check()} busy={busy}>
          Check
        </Button>
      }
    >
      {error ? (
        <ErrorNote message={error} onRetry={() => void check()} />
      ) : report ? (
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--color-text-tertiary)]">Status</dt>
            <dd className="mt-0.5 flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: statusColor(report.ok ? 'up' : 'down') }}
                aria-hidden="true"
              />
              {statusLabel(report.ok ? 'up' : 'down')}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-tertiary)]">Version</dt>
            <dd className="tabular mt-0.5">{report.version}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-tertiary)]">Database</dt>
            <dd className="tabular mt-0.5">
              {report.database.provider} · {report.database.dialect} · {report.database.server_version}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-tertiary)]">Database latency</dt>
            <dd className="tabular mt-0.5">{report.database.latency_ms}ms</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-tertiary)]">Environment</dt>
            <dd className="mt-0.5">{report.environment}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-tertiary)]">Checked</dt>
            <dd className="tabular mt-0.5">{new Date(report.timestamp).toLocaleTimeString()}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-[var(--color-text-tertiary)]">
          Run a check to see the database provider, its latency and the deployed version.
        </p>
      )}
    </Panel>
  );
}
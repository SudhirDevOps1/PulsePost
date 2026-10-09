import { useCallback, useEffect, useState } from 'react';

import { api, ApiError } from '../api.ts';
import type { SessionUser } from '../types.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Panel,
  Skeleton,
  inputClass,
  selectClass,
  timeAgo,
} from '../components/ui.tsx';

/**
 * Team and access control.
 *
 * Roles are enforced server-side on every mutating route (`requireAuth`), so
 * this screen is a convenience layer over that, not the enforcement point. The
 * API for it was always complete; what was missing was any way to reach it.
 *
 * Two server-side guards shape what this screen offers, and both are mirrored
 * in the UI so the operator is not invited to attempt something that will 409:
 *   - the last remaining admin cannot be demoted, disabled or deleted
 *   - nobody can delete their own account, or edit one of equal/higher rank
 */

const ROLE_LABEL: Record<SessionUser['role'], string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

const ROLE_HINT: Record<SessionUser['role'], string> = {
  admin: 'Everything, including deleting monitors, channels and other users.',
  editor: 'Create and edit monitors, groups, incidents and channels.',
  viewer: 'Read-only. Cannot change anything.',
};

/** Rank lets the client mirror the server's "no acting above yourself" rule. */
const ROLE_RANK: Record<SessionUser['role'], number> = { viewer: 0, editor: 1, admin: 2 };

export function TeamPage({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<SessionUser['role']>('viewer');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [totpFor, setTotpFor] = useState<SessionUser | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.users();
      setUsers(result.users ?? []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load the team');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const adminCount = users.filter((user) => user.role === 'admin').length;
  const me = users.find((user) => user.id === currentUserId);
  const myRank = me ? ROLE_RANK[me.role] : -1;

  async function invite() {
    setBusy(true);
    setFieldErrors({});
    try {
      await api.createUser({ name, email, password, role });
      setName('');
      setEmail('');
      setPassword('');
      setNotice('Account created');
      await load();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setFieldErrors(Object.fromEntries(cause.issues.map((i) => [i.field, i.message])));
        setError(cause.message);
      } else {
        setError('Could not create the account');
      }
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(user: SessionUser, next: SessionUser['role']) {
    setBusy(true);
    try {
      await api.updateUser(user.id, { role: next });
      setNotice(`${user.name} is now ${ROLE_LABEL[next].toLowerCase()}`);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not change the role');
    } finally {
      setBusy(false);
    }
  }

  async function toggleDisabled(user: SessionUser) {
    setBusy(true);
    try {
      await api.updateUser(user.id, { disabled: true });
      setNotice(`${user.name} disabled`);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not disable the account');
    } finally {
      setBusy(false);
    }
  }

  async function remove(user: SessionUser) {
    if (!confirm(`Delete ${user.name}? Their sessions stop working immediately.`)) return;
    setBusy(true);
    try {
      await api.deleteUser(user.id);
      setNotice('Account deleted');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not delete the account');
    } finally {
      setBusy(false);
    }
  }

  async function disableTotp(user: SessionUser) {
    if (!confirm(`Turn off two-factor authentication for ${user.name}?`)) return;
    setBusy(true);
    try {
      await api.disableTotp(user.id);
      setNotice('Two-factor disabled');
      setTotpFor(null);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not disable two-factor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Team</h1>
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {users.length} account{users.length === 1 ? '' : 's'} · {adminCount} admin
          {adminCount === 1 ? '' : 's'}
        </p>
      </header>

      {notice ? (
        <p className="text-xs text-[var(--color-up)]" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <ErrorNote message={error} onRetry={() => void load()} /> : null}

      <Panel title="Add someone">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={fieldErrors.name}>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Email" error={fieldErrors.email}>
            <input
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="off"
            />
          </Field>
          <Field label="Temporary password" error={fieldErrors.password} hint="At least 12 characters.">
            <input
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Role" hint={ROLE_HINT[role]}>
            <select
              className={selectClass}
              value={role}
              onChange={(e) => setRole(e.target.value as SessionUser['role'])}
            >
              {(['viewer', 'editor', 'admin'] as const).map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABEL[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-4">
          <Button variant="primary" busy={busy} onClick={() => void invite()}>
            Create account
          </Button>
        </div>
      </Panel>

      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : users.length === 0 ? (
        <Panel>
          <EmptyState title="No accounts" />
        </Panel>
      ) : (
        <div className="space-y-3">
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            const isLastAdmin = user.role === 'admin' && adminCount === 1;
            // Mirrors the server's rank guard so the UI does not offer an
            // action that is guaranteed to be refused.
            const outranked = !isSelf && myRank >= 0 && ROLE_RANK[user.role] > myRank;

            return (
              <Panel
                key={user.id}
                title={
                  <span className="flex items-center gap-2">
                    <span className="truncate-1">{user.name}</span>
                    {isSelf ? <Badge>you</Badge> : null}
                    {user.totp_enabled ? <Badge color="var(--color-accent-text)">2FA</Badge> : null}
                  </span>
                }
                subtitle={
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>{user.email}</span>
                    <span>last seen {timeAgo(user.last_login_at)}</span>
                  </span>
                }
                actions={<Badge color="var(--color-accent-text)">{ROLE_LABEL[user.role]}</Badge>}
              >
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Role" className="w-40">
                    <select
                      className={selectClass}
                      value={user.role}
                      disabled={busy || isSelf || isLastAdmin || outranked}
                      onChange={(e) => void changeRole(user, e.target.value as SessionUser['role'])}
                    >
                      {(['viewer', 'editor', 'admin'] as const).map((value) => (
                        <option key={value} value={value}>
                          {ROLE_LABEL[value]}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <div className="flex gap-2 pb-0.5">
                    {/* TOTP enrolment is self-service only — the server refuses
                    `POST /users/:id/totp/*` for anyone but the account owner,
                    so offering it for another user would only ever 403. */}
                    {isSelf ? (
                      user.totp_enabled ? (
                        <Button size="sm" busy={busy} onClick={() => void disableTotp(user)}>
                          Disable 2FA
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => setTotpFor(user)}>
                          Enable 2FA
                        </Button>
                      )
                    ) : user.totp_enabled ? (
                      <span className="self-center pb-1 text-[11px] text-[var(--color-text-tertiary)]">
                        2FA enabled
                      </span>
                    ) : null}

                    {!isSelf && !isLastAdmin ? (
                      <Button size="sm" busy={busy} onClick={() => void toggleDisabled(user)}>
                        Disable account
                      </Button>
                    ) : null}

                    {!isSelf && !isLastAdmin && !outranked ? (
                      <Button size="sm" variant="danger" onClick={() => void remove(user)}>
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </div>

                {isLastAdmin && !isSelf ? (
                  <p className="mt-3 text-[11px] text-[var(--color-text-tertiary)]">
                    The last admin cannot be demoted or deleted — promote someone else first.
                  </p>
                ) : null}
              </Panel>
            );
          })}
        </div>
      )}

      {totpFor ? (
        <TotpDialog user={totpFor} busy={busy} onClose={() => setTotpFor(null)} onDone={load} />
      ) : null}
    </div>
  );
}

/**
 * Two-factor enrolment.
 *
 * The secret is shown once and never again — the server stores it encrypted and
 * has no read endpoint, so losing this dialog means starting over.
 */
function TotpDialog({
  user,
  busy,
  onClose,
  onDone,
}: {
  user: SessionUser;
  busy: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .startTotp(user.id)
      .then((result) => {
        if (!cancelled) setSecret(result.secret);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause.message : 'Could not start enrolment');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  async function confirm() {
    try {
      await api.confirmTotp(user.id, code);
      await onDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That code was not accepted');
    }
  }

  return (
    <Panel title={`Two-factor for ${user.name}`} subtitle="Shown once — store it in your authenticator now.">
      <div className="space-y-4">
        {error ? <ErrorNote message={error} /> : null}

        {secret ? (
          <>
            <div className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-wide text-[var(--color-text-tertiary)]">Secret</p>
              <p className="tabular mt-1 break-all text-sm">{secret}</p>
            </div>

            <Field label="Code from your authenticator">
              <input
                className={`${inputClass} tabular`}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
              />
            </Field>

            <div className="flex gap-2">
              <Button variant="primary" busy={busy} disabled={code.length < 6} onClick={() => void confirm()}>
                Confirm
              </Button>
              <Button onClick={onClose}>Cancel</Button>
            </div>
          </>
        ) : error ? null : (
          <Skeleton className="h-24" />
        )}
      </div>
    </Panel>
  );
}
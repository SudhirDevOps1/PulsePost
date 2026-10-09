import { useEffect, useState } from 'react';

import { ApiError } from '../api.ts';
import type { SessionUser } from '../types.ts';
import { Button, ErrorNote, Field, inputClass } from '../components/ui.tsx';

/**
 * Authentication screens: first-run setup and subsequent login.
 *
 * Both are intentionally plain — they are the only screens a single operator
 * sees before anything is configured, so clarity beats decoration.
 */

export interface AuthState {
  setupComplete: boolean;
  authenticated: boolean;
  user: SessionUser | null;
  appName: string;
}

export function LoginPage({
  state,
  onDone,
}: {
  state: AuthState;
  onDone: (user: SessionUser, appName: string) => void;
}) {
  return state.setupComplete ? <LoginForm onDone={onDone} /> : <SetupForm onDone={onDone} />;
}

function SetupForm({ onDone }: { onDone: (user: SessionUser, appName: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [appName, setAppName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const { user } = await apiSetup({
        name,
        email,
        password,
        ...(appName.trim() ? { app_name: appName.trim() } : {}),
      });
      onDone(user, appName.trim() || 'PulsePost');
    } catch (cause) {
      applyError(cause, setError, setFieldErrors);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Set up PulsePost"
      subtitle="Create the first administrator account. You can add more later."
    >
      <form className="space-y-3.5" onSubmit={submit}>
        {error ? <ErrorNote message={error} /> : null}

        <Field label="Your name" error={fieldErrors.name}>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
            autoFocus
          />
        </Field>

        <Field label="Email" error={fieldErrors.email}>
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>

        <Field
          label="Password"
          error={fieldErrors.password}
          hint="At least 12 characters with upper, lower, a number and a symbol."
        >
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>

        <Field label="Instance name" hint="Shown on the public status page.">
          <input
            className={inputClass}
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder="Acme Status"
          />
        </Field>

        <Button type="submit" variant="primary" busy={busy} className="w-full">
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}

function LoginForm({ onDone }: { onDone: (user: SessionUser, appName: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await apiLogin({
        email,
        password,
        ...(needsTotp && totp ? { totp_code: totp } : {}),
      });

      // Re-read the session rather than trusting the login response, so the
      // shell renders with authoritative server state.
      const status = await apiStatus();
      if (status.user) {
        onDone(status.user, status.app_name);
      } else {
        setError('Signed in, but the session could not be read back. Please reload.');
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'TOTP_REQUIRED') {
        setNeedsTotp(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(cause instanceof ApiError ? cause.message : 'Sign-in failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Access your monitors and status pages.">
      <form className="space-y-3.5" onSubmit={submit}>
        {error ? <ErrorNote message={error} /> : null}

        <Field label="Email">
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </Field>

        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        {needsTotp ? (
          <Field label="Authenticator code">
            <input
              className={`${inputClass} tabular`}
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
            />
          </Field>
        ) : null}

        <Button type="submit" variant="primary" busy={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle ? (
              <p className="mt-1 text-sm text-[--color-text-tertiary]">{subtitle}</p>
            ) : null}
          </div>
        </div>

        <div className="panel p-5">{children}</div>

        <p className="mt-4 text-center text-[11px] text-[--color-text-tertiary]">
          Self-hosted uptime monitoring · no telemetry
        </p>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="4" cy="6" r="2.2" fill="var(--color-up)" />
      <circle cx="4" cy="18" r="2.2" fill="var(--color-up)" />
      <circle cx="20" cy="12" r="2.4" fill="var(--color-accent)" />
      <path
        d="M6.2 6.5h2.8a2 2 0 0 1 2 2v7a2 2 0 0 0 2 2h3M6.2 17.5h2.8a2 2 0 0 0 2-2v-7a2 2 0 0 1 2-2h3"
        stroke="var(--color-text-tertiary)"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Imported lazily to keep this module free of a circular import through api.ts.
import { api } from '../api.ts';

async function apiSetup(input: {
  name: string;
  email: string;
  password: string;
  app_name?: string;
}) {
  return api.setup(input);
}

async function apiLogin(input: { email: string; password: string; totp_code?: string }) {
  return api.login(input);
}

async function apiStatus() {
  return api.authStatus();
}

function applyError(
  cause: unknown,
  setError: (message: string) => void,
  setFieldErrors: (errors: Record<string, string>) => void,
) {
  if (cause instanceof ApiError) {
    setFieldErrors(
      Object.fromEntries(cause.issues.map((issue) => [issue.field, issue.message])),
    );
    setError(cause.issues.length > 0 ? cause.issues.map((i) => i.message).join(' · ') : cause.message);
  } else {
    setError('Something went wrong');
  }
}

export { useEffect };
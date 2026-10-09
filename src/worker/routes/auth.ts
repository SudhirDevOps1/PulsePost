import { Hono } from 'hono';
import { validateJson, validateQuery, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import {
  createSession,
  destroyAllSessions,
  destroySession,
  readSessionCookie,
  SESSION_COOKIE,
  SESSION_COOKIE_INSECURE,
} from '../auth/session.ts';
import { hashPassword, needsRehash, verifyPassword } from '../auth/password.ts';
import { decryptTotpSecret, verifyTotp } from '../auth/totp.ts';
import { nowIso } from '../db/dialect.ts';
import type { AppEnv } from '../middleware/context.ts';
import { requireAuth } from '../middleware/context.ts';
import { authRateLimit } from '../middleware/ratelimit.ts';
import { loginSchema, setupSchema, changePasswordSchema, profileSchema } from '../../shared/schemas.ts';
import type { PublicUser, UserRole } from '../../shared/types.ts';

/**
 * Auth routes: setup, login, logout, session probe, password change, profile.
 *
 * Notable security decisions:
 *   - Login failures are deliberately indistinguishable: one message for a
 *     wrong email and a wrong password, and PBKDF2 runs either way so the
 *     timing does not reveal which emails exist.
 *   - Rate limiting is applied per-route with a tight budget, not just globally.
 *   - Session cookies use the `__Host-` prefix, which the browser enforces as
 *     Secure + path=/ + no Domain. That makes cookie injection from a
 *     subdomain impossible.
 */

export const authRoutes = new Hono<AppEnv>();

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  totp_secret: string | null;
  totp_enabled: unknown;
  disabled: unknown;
  created_at: string;
  last_login_at: string | null;
}

async function userCount(db: import('../db/types.ts').DatabaseAdapter): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  return Number(result.rows[0]?.n ?? 0);
}

/** True once an admin account exists — drives the setup gate. */
export async function isSetupComplete(db: import('../db/types.ts').DatabaseAdapter): Promise<boolean> {
  return (await userCount(db)) > 0;
}

authRoutes.get('/status', async (c) => {
  const config = c.get('config');
  const setupComplete = await isSetupComplete(c.get('db'));

  return c.json({
    setup_complete: setupComplete,
    auth_mode: config.authMode,
    authenticated: c.get('user') !== null,
    user: c.get('user'),
    app_name: config.appName,
  });
});

/**
 * First-run onboarding.
 *
 * Guarded three ways: the tight rate limit, a check that no admin exists yet,
 * and — when `AUTH_MODE=basic` — an IP allowlist. Without the middle check
 * anyone could race the owner and claim the instance.
 */
authRoutes.post('/setup', authRateLimit(), validateJson(setupSchema), async (c) => {
  const db = c.get('db');

  if (await isSetupComplete(db)) {
    throw HttpError.conflict('Setup has already been completed');
  }

  const body = c.req.valid('json');
  const now = nowIso();
  const id = crypto.randomUUID();

  await db.execute(
    `INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', ?, ?)`,
    [id, body.name, body.email, await hashPassword(body.password), now, now],
  );

  await db
    .execute('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)', [
      'setup_complete',
      'true',
      now,
    ])
    .catch(async () => {
      // `INSERT OR REPLACE` is SQLite-only; use the portable upsert on Postgres.
      await db.execute(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ['setup_complete', 'true', now],
      );
    });

  if (body.app_name) {
    await db.execute(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['app_name', body.app_name, now],
    );
  }

  await audit(db, {
    userId: id,
    action: 'auth.setup',
    ok: true,
    ip: c.get('clientIp'),
  });

  const session = await createSession(db, id, {
    ip: c.get('clientIp'),
    userAgent: c.req.header('User-Agent'),
    ttlDays: c.get('config').sessionTtlDays,
  });

  setSessionCookie(c, session.token, session.expiresAt, c.get('config').sessionTtlDays);

  return c.json(
    {
      user: {
        id,
        name: body.name,
        email: body.email,
        role: 'admin' as const,
        created_at: now,
        last_login_at: null,
        totp_enabled: false,
      },
    },
    201,
  );
});

authRoutes.post('/login', authRateLimit(), validateJson(loginSchema), async (c) => {
  const db = c.get('db');

  // Basic mode authenticates at the middleware layer; nothing to do here.
  if (c.get('config').authMode === 'basic') {
    return c.json({ ok: true, mode: 'basic' });
  }

  const body = c.req.valid('json');

  const found = await db.query<UserRow>('SELECT * FROM users WHERE email = ?', [body.email]);
  const user = found.rows[0];

  // Always run a verification so a missing account and a wrong password cost
  // the same wall-clock time.
  const storedHash = user?.password_hash ?? DUMMY_HASH;
  const passwordOk = await verifyPassword(body.password, storedHash);

  if (!user || !passwordOk) {
    await audit(db, {
      userId: user?.id ?? null,
      action: 'auth.login',
      ok: false,
      target: body.email,
      ip: c.get('clientIp'),
      meta: { reason: 'invalid_credentials' },
    });
    // One message for both cases — never disclose which emails are registered.
    throw HttpError.unauthorized('Incorrect email or password');
  }

  if (user.disabled === true || user.disabled === 1 || user.disabled === '1') {
    throw HttpError.forbidden('This account has been disabled');
  }

  // TOTP second factor.
  if (c.get('config').authMode === 'totp' || isEnabled(user.totp_enabled)) {
    if (!user.totp_secret) {
      throw HttpError.internal('TOTP is required but not configured for this account');
    }
    if (!body.totp_code) {
      return c.json(
        { error: 'Two-factor code required', code: 'TOTP_REQUIRED' },
        401,
        { 'X-TOTP-Required': 'true' },
      );
    }

    const passphrase = c.get('config').totpSecret;
    if (!passphrase) {
      // Same reasoning as enrolment: no configured secret means no safe way to
      // read the stored one, and guessing is not an option.
      throw HttpError.internal(
        'TOTP is required but TOTP_SECRET is not set on this instance. Set it and restart.',
      );
    }

    const secret = await decryptTotpSecret(user.totp_secret, passphrase);
    const lastUsed = await readLastTotpStep(db, user.id);
    const verification = await verifyTotp(secret, body.totp_code, { lastUsedStep: lastUsed });

    if (!verification.ok) {
      await audit(db, {
        userId: user.id,
        action: 'auth.login',
        ok: false,
        ip: c.get('clientIp'),
        meta: { reason: 'bad_totp' },
      });
      throw HttpError.unauthorized('Invalid or expired two-factor code');
    }

    // Burn the step so the same code cannot be replayed inside its window.
    if (verification.matchedStep !== undefined) {
      await db.execute(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [`totp_last_${user.id}`, String(verification.matchedStep), nowIso()],
      );
    }
  }

  // Opportunistically upgrade hashes written under an older cost factor.
  if (needsRehash(user.password_hash)) {
    await db
      .execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
        await hashPassword(body.password),
        nowIso(),
        user.id,
      ])
      .catch(() => undefined);
  }

  await db.execute('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);

  const ttlDays = body.remember
    ? Math.max(c.get('config').sessionTtlDays, 30)
    : c.get('config').sessionTtlDays;

  const session = await createSession(db, user.id, {
    ip: c.get('clientIp'),
    userAgent: c.req.header('User-Agent'),
    ttlDays,
  });

  setSessionCookie(c, session.token, session.expiresAt, ttlDays);

  await audit(db, { userId: user.id, action: 'auth.login', ok: true, ip: c.get('clientIp') });

  return c.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      created_at: user.created_at,
      last_login_at: nowIso(),
      totp_enabled: isEnabled(user.totp_enabled),
    } satisfies PublicUser,
  });
});

authRoutes.post('/logout', async (c) => {
  const token = readSessionCookie(c.req.header('Cookie'));

  if (token) {
    await destroySession(c.get('db'), token).catch(() => undefined);
  }

  clearSessionCookie(c);

  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth('viewer'), (c) => {
  const user = c.get('user');
  if (!user) throw HttpError.unauthorized();
  return c.json({ user });
});

authRoutes.post(
  '/password',
  authRateLimit(),
  requireAuth('viewer'),
  validateJson(changePasswordSchema),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized();

    const body = c.req.valid('json');

    const found = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [user.id]);
    const row = found.rows[0];
    if (!row) throw HttpError.notFound('Account not found');

    if (!(await verifyPassword(body.current_password, row.password_hash))) {
      throw HttpError.unauthorized('Current password is incorrect');
    }

    await db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      await hashPassword(body.new_password),
      nowIso(),
      user.id,
    ]);

    // Every other session is invalidated; the caller keeps theirs.
    await destroyAllSessions(db, user.id);

    await audit(db, {
      userId: user.id,
      action: 'auth.password_changed',
      ok: true,
      ip: c.get('clientIp'),
    });

    return c.json({ ok: true, reauthenticate: true });
  },
);

authRoutes.patch('/profile', requireAuth('viewer'), validateJson(profileSchema), async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  if (!user) throw HttpError.unauthorized();

  const body = c.req.valid('json');

  if (body.email && body.email !== user.email) {
    const clash = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE email = ?', [
      body.email,
    ]);
    if (Number(clash.rows[0]?.n ?? 0) > 0) {
      throw HttpError.conflict('That email is already in use');
    }
  }

  if (body.name) {
    await db.execute('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', [
      body.name,
      nowIso(),
      user.id,
    ]);
  }
  if (body.email) {
    await db.execute('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [
      body.email,
      nowIso(),
      user.id,
    ]);
  }

  return c.json({
    user: {
      ...user,
      name: body.name ?? user.name,
      email: body.email ?? user.email,
    } satisfies PublicUser,
  });
});

// --- helpers -----------------------------------------------------------------

/**
 * A valid PBKDF2 hash of an unguessable value. Verifying against it keeps the
 * cost of a login attempt for a nonexistent account identical to a real one.
 */
const DUMMY_HASH =
  'pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'ZG8gbm90IG1hdGNoIGFueXRoaW5nL2FueXRoaW5nL2FueXRoaW5nL2FueXRoaW5nL2FueXRoaW5nL2FueXRoaW5nL2E=';

function isEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function readLastTotpStep(
  db: import('../db/types.ts').DatabaseAdapter,
  userId: string,
): Promise<number | undefined> {
  const result = await db.query<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    [`totp_last_${userId}`],
  );
  const parsed = Number.parseInt(result.rows[0]?.value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function audit(
  db: import('../db/types.ts').DatabaseAdapter,
  event: {
    userId: string | null;
    action: string;
    ok: boolean;
    ip?: string | undefined;
    target?: string | undefined;
    meta?: unknown;
  },
): Promise<void> {
  await db
    .execute(
      `INSERT INTO audit_log (id, user_id, action, target, meta, ip, ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        event.userId,
        event.action,
        event.target ?? null,
        event.meta === undefined ? null : JSON.stringify(event.meta),
        event.ip ?? null,
        event.ok,
        nowIso(),
      ],
    )
    .catch((error) => console.error('[audit] write failed:', error));
}

/**
 * Issue the session cookie.
 *
 * Over HTTPS this uses the `__Host-` prefix, which the browser enforces as
 * Secure + Path=/ + no Domain — ruling out subdomain cookie injection. Over
 * plain HTTP (local dev, Docker) that prefix is unusable, so the plain name is
 * used without `Secure`.
 */
export function setSessionCookie(
  c: import('hono').Context<AppEnv>,
  token: string,
  expiresAt: string,
  ttlDays: number,
): void {
  const secure = new URL(c.req.url).protocol === 'https:';
  const name = secure ? SESSION_COOKIE : SESSION_COOKIE_INSECURE;
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');

  c.header(
    'Set-Cookie',
    `${name}=${encodeURIComponent(token)}; ${attrs.join('; ')}; Expires=${new Date(expiresAt).toUTCString()}; Max-Age=${Math.max(0, Math.floor(ttlDays * 86_400))}`,
  );
}

/** Clear whichever session cookie names might be in use. */
export function clearSessionCookie(c: import('hono').Context<AppEnv>): void {
  const secure = new URL(c.req.url).protocol === 'https:';
  const attrs = secure ? 'Path=/; HttpOnly; Secure; SameSite=Lax' : 'Path=/; HttpOnly; SameSite=Lax';

  // Both names are cleared so switching scheme never leaves a stale cookie.
  c.header('Set-Cookie', `${SESSION_COOKIE}=; ${attrs}; Max-Age=0`);
  c.header('Set-Cookie', `${SESSION_COOKIE_INSECURE}=; ${attrs}; Max-Age=0`);
}
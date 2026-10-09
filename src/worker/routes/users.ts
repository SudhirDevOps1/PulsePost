import { Hono } from 'hono';
import { z } from 'zod';

import { validateJson, validateParam } from '../http/validate.ts';
import { HttpError } from '../http/errors.ts';
import { requireAuth } from '../middleware/context.ts';
import type { AppEnv } from '../middleware/context.ts';
import { apiRateLimit, authRateLimit } from '../middleware/ratelimit.ts';
import { nowIso } from '../db/dialect.ts';
import { destroyAllSessions, toBool, toPublicUser } from '../auth/session.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  otpauthUri,
  verifyTotp,
} from '../auth/totp.ts';
import { audit } from './auth.ts';
import { createUserSchema, updateUserSchema, idParamSchema } from '../../shared/schemas.ts';
import type { PublicUser, UserRole } from '../../shared/types.ts';

/**
 * User management.
 *
 * Two invariants this module exists to enforce:
 *
 *   1. **The last admin cannot be removed or demoted.** Locking yourself out of
 *      your own monitor is unrecoverable — you would have to shell into D1.
 *   2. **You cannot edit an account with a role above your own.** Otherwise a
 *      `viewer` could promote themselves to `admin` by calling the API.
 */

export const userRoutes = new Hono<AppEnv>();

userRoutes.use('*', apiRateLimit(), requireAuth('admin'));

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  totp_secret: string | null;
  totp_enabled: unknown;
  disabled: unknown;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

const RANK: Record<UserRole, number> = { admin: 3, editor: 2, viewer: 1 };

/** Inline schemas kept local so they cannot be reused where they do not apply. */
const totpCodeSchema = z
  .object({ code: z.string().trim().regex(/^\d{6}$/, 'Must be 6 digits') })
  .strict();

const passwordSchema = z
  .object({
    current_password: z.string().min(1).max(1024),
    new_password: z.string().min(12).max(1024),
  })
  .strict();

/**
 * Project a row down to the fields a client is allowed to see.
 *
 * Fields are listed one by one rather than spread, so adding a column to
 * `users` — a reset token, a recovery code — cannot accidentally leak it into
 * an API response.
 */
function toSafeUser(row: UserRow): PublicUser & { disabled: boolean } {
  return {
    ...toPublicUser({
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      role: row.role as UserRole,
      totp_enabled: row.totp_enabled,
      created_at: String(row.created_at),
      last_login_at: row.last_login_at === null ? null : String(row.last_login_at),
    }),
    disabled: toBool(row.disabled),
  };
}

userRoutes.get('/', async (c) => {
  const result = await c.get('db').query<UserRow>('SELECT * FROM users ORDER BY created_at ASC');

  return c.json({ users: result.rows.map(toSafeUser) });
});

userRoutes.post('/', validateJson(createUserSchema), async (c) => {
  const db = c.get('db');
  const body = c.req.valid('json');

  const existing = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE email = ?', [
    body.email,
  ]);
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    throw HttpError.conflict('An account with that email already exists');
  }

  const id = crypto.randomUUID();
  const now = nowIso();

  await db.execute(
    `INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, body.name, body.email, await hashPassword(body.password), body.role, now, now],
  );

  await audit(db, {
    userId: c.get('user')?.id ?? null,
    action: 'user.create',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  return c.json(
    {
      user: {
        id,
        name: body.name,
        email: body.email,
        role: body.role,
        created_at: now,
        last_login_at: null,
        totp_enabled: false,
      } satisfies PublicUser,
    },
    201,
  );
});

userRoutes.patch('/:id', validateParam(idParamSchema), validateJson(updateUserSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const actor = c.get('user')!;

  const found = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  const row = found.rows[0];
  if (!row) throw HttpError.notFound('User not found');

  // Cannot edit someone *above* your own privilege level. Equal rank is
  // allowed: otherwise two admins could never manage each other, and the
  // second admin would be permanently un-demotable by the first. Self-edits
  // skip this check but are still constrained by the last-admin guard below.
  if (RANK[row.role as UserRole] > RANK[actor.role] && id !== actor.id) {
    throw HttpError.forbidden('You cannot modify an account with a higher role');
  }

  const removingAdmin = row.role === 'admin' && (body.role !== undefined && body.role !== 'admin');
  if (removingAdmin && (await lastAdmin(db, id))) {
    throw HttpError.conflict('Cannot demote the only remaining admin');
  }

  const disablingAdmin = row.role === 'admin' && body.disabled === true;
  if (disablingAdmin && (await lastAdmin(db, id))) {
    throw HttpError.conflict('Cannot disable the only remaining admin');
  }

  if (body.email) {
    const clash = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM users WHERE email = ? AND id <> ?',
      [body.email, id],
    );
    if (Number(clash.rows[0]?.n ?? 0) > 0) {
      throw HttpError.conflict('That email is already in use');
    }
  }

  const columns: Record<string, unknown> = {
    name: body.name,
    email: body.email,
    role: body.role,
    disabled: body.disabled,
  };

  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }

  if (body.password) {
    assignments.push('password_hash = ?');
    values.push(await hashPassword(body.password));
    // A forced reset invalidates every existing session for that account.
    await destroyAllSessions(db, id);
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = ?');
    values.push(nowIso(), id);
    await db.execute(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, values);
  }

  await audit(db, {
    userId: actor.id,
    action: 'user.update',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  const updated = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  return c.json({ user: toSafeUser(updated.rows[0]!) });
});

userRoutes.delete('/:id', validateParam(idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');
  const actor = c.get('user')!;

  if (id === actor.id) {
    throw HttpError.badRequest('You cannot delete your own account from the UI');
  }

  const found = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  const row = found.rows[0];
  if (!row) throw HttpError.notFound('User not found');

  if (RANK[row.role as UserRole] >= RANK[actor.role]) {
    throw HttpError.forbidden('You cannot delete an account with an equal or higher role');
  }

  if (row.role === 'admin' && (await lastAdmin(db, id))) {
    throw HttpError.conflict('Cannot delete the only remaining admin');
  }

  await db.execute('DELETE FROM users WHERE id = ?', [id]);

  await audit(db, {
    userId: actor.id,
    action: 'user.delete',
    target: id,
    ok: true,
    ip: c.get('clientIp'),
  });

  return c.json({ ok: true });
});

// --- TOTP --------------------------------------------------------------------

/**
 * Begin TOTP enrolment.
 * Returns the secret and an `otpauth://` URI. The secret is only persisted
 * once the user proves they can generate a code, via `POST /:id/totp/confirm`.
 */
userRoutes.post('/:id/totp/start', validateParam(idParamSchema), authRateLimit(), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');
  const actor = c.get('user')!;

  if (id !== actor.id) {
    throw HttpError.forbidden('You can only enrol your own account in TOTP');
  }

  const row = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  const user = row.rows[0];
  if (!user) throw HttpError.notFound('User not found');

  // Without this the secret would have to be stored under a key anyone can
  // read, which defeats the point of encrypting it.
  const passphrase = requireTotpPassphrase(c);

  const secret = generateTotpSecret();
  await db.execute(
    'UPDATE users SET totp_secret = ?, totp_enabled = ?, updated_at = ? WHERE id = ?',
    [await encryptTotpSecret(secret, passphrase), false, nowIso(), id],
  );

  return c.json({
    secret,
    uri: otpauthUri({
      secret,
      accountName: user.email,
      issuer: c.get('config').appName,
    }),
  });
});

/** Verify a code and switch TOTP on. */
userRoutes.post(
  '/:id/totp/confirm',
  validateParam(idParamSchema),
  authRateLimit(),
  validateJson(totpCodeSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const db = c.get('db');
    const actor = c.get('user')!;

    if (id !== actor.id) throw HttpError.forbidden('You can only configure your own account');

    const row = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
    const user = row.rows[0];
    if (!user?.totp_secret) throw HttpError.badRequest('Start enrolment before confirming');

    const verification = await verifyTotp(
      await decryptTotpSecret(user.totp_secret, requireTotpPassphrase(c)),
      body.code,
    );

    if (!verification.ok) throw HttpError.badRequest(verification.reason ?? 'Invalid code');

    await db.execute('UPDATE users SET totp_enabled = ?, updated_at = ? WHERE id = ?', [
      true,
      nowIso(),
      id,
    ]);

    await audit(db, {
      userId: actor.id,
      action: 'user.totp_enabled',
      target: id,
      ok: true,
      ip: c.get('clientIp'),
    });

    return c.json({ ok: true });
  },
);

userRoutes.post('/:id/totp/disable', validateParam(idParamSchema), authRateLimit(), async (c) => {
  const { id } = c.req.valid('param');
  const db = c.get('db');
  const actor = c.get('user')!;

  if (id !== actor.id) throw HttpError.forbidden('You can only configure your own account');

  await db.execute(
    'UPDATE users SET totp_secret = NULL, totp_enabled = ?, updated_at = ? WHERE id = ?',
    [false, nowIso(), id],
  );

  return c.json({ ok: true });
});

/** Change your own password without a session reset, for self-service. */
userRoutes.post('/:id/password', validateParam(idParamSchema), authRateLimit(), validateJson(passwordSchema), async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = c.get('db');
  const actor = c.get('user')!;

  if (id !== actor.id) throw HttpError.forbidden('You can only change your own password');

  const row = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  const user = row.rows[0];
  if (!user) throw HttpError.notFound('User not found');

  if (!(await verifyPassword(body.current_password, user.password_hash))) {
    throw HttpError.unauthorized('Current password is incorrect');
  }

  await db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    await hashPassword(body.new_password),
    nowIso(),
    id,
  ]);

  return c.json({ ok: true });
});

// --- helpers -----------------------------------------------------------------

/**
 * Fetch the configured TOTP encryption passphrase.
 *
 * Failing loudly here is deliberate: silently falling back to a built-in key
 * would look like success while storing secrets under a value the entire world
 * can read.
 */
function requireTotpPassphrase(c: { get: (k: 'config') => { totpSecret?: string } }): string {
  const secret = c.get('config').totpSecret;
  if (!secret) {
    throw new HttpError(
      501,
      'TOTP is not configured on this instance. Set the TOTP_SECRET environment variable and restart.',
      'TOTP_UNCONFIGURED',
    );
  }
  return secret;
}

/** True when this is the final admin account still standing. */
async function lastAdmin(db: import('../db/types.ts').DatabaseAdapter, excludeId: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = ? AND id <> ?",
    [false, excludeId],
  );
  return Number(result.rows[0]?.n ?? 0) === 0;
}

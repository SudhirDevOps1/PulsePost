import { randomToken, sha256Hex } from './password.ts';
import { nowIso } from './../db/dialect.ts';
import type { DatabaseAdapter } from './../db/types.ts';
import type { PublicUser, UserRole } from './../../shared/types.ts';

/**
 * Session management.
 *
 * Two deliberate choices:
 *
 *  1. Only `sha256(token)` is stored. A database leak therefore does not hand
 *     an attacker usable cookies — they would still have to brute-force a
 *     256-bit random value.
 *  2. Expiry is sliding: each successful use pushes `expires_at` forward,
 *     capped by an absolute lifetime, so an active admin is not logged out
 *     mid-session while an abandoned cookie still dies on its own.
 */

/**
 * Session cookie names.
 *
 * In production we use the `__Host-` prefix, which the *browser* enforces as
 * Secure + Path=/ + no Domain attribute. That is the strongest available
 * protection against subdomain cookie injection, and it only works over HTTPS.
 *
 * Over plain HTTP — local `wrangler dev`, the Docker image — a `__Host-` cookie
 * is silently rejected, which would make auth appear broken locally. So the
 * plain name is used there instead, minus `Secure`.
 */
export const SESSION_COOKIE = '__Host-pp_session';
export const SESSION_COOKIE_INSECURE = 'pp_session';

/** Pick the cookie name appropriate for the request's scheme. */
export function sessionCookieName(requestUrl: string): string {
  try {
    return new URL(requestUrl).protocol === 'https:' ? SESSION_COOKIE : SESSION_COOKIE_INSECURE;
  } catch {
    return SESSION_COOKIE;
  }
}

/** Read the session cookie, accepting either name. */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE && name !== SESSION_COOKIE_INSECURE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  totp_secret: string | null;
  totp_enabled: number | boolean;
  disabled: number | boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

/** Absolute session lifetime; sliding refresh can never push past this. */
const ABSOLUTE_LIFETIME_DAYS = 30;

export interface CreatedSession {
  token: string;
  expiresAt: string;
  absoluteExpiry: string;
}

export async function createSession(
  db: DatabaseAdapter,
  userId: string,
  options: {
    ip?: string | undefined;
    userAgent?: string | undefined;
    ttlDays: number;
    now?: Date;
  },
): Promise<CreatedSession> {
  const now = options.now ?? new Date();
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);

  const slidingExpiry = new Date(now.getTime() + options.ttlDays * 86_400_000);
  const absoluteExpiry = new Date(now.getTime() + ABSOLUTE_LIFETIME_DAYS * 86_400_000);
  const expiresAt = slidingExpiry < absoluteExpiry ? slidingExpiry : absoluteExpiry;

  await db.execute(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      userId,
      tokenHash,
      now.toISOString(),
      expiresAt.toISOString(),
      now.toISOString(),
      options.ip ?? null,
      options.userAgent?.slice(0, 400) ?? null,
    ],
  );

  return { token, expiresAt: expiresAt.toISOString(), absoluteExpiry: absoluteExpiry.toISOString() };
}

export interface ResolvedSession {
  session: SessionRow;
  user: PublicUser;
}

/**
 * Column aliases for the join that loads a session together with its user.
 * Both tables have `id`, `created_at` and friends, so they must be disambiguated
 * before the row can be split back apart.
 */
interface SessionUserRow {
  s_id: string;
  user_id: string;
  token_hash: string;
  s_created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  u_id: string;
  name: string;
  email: string;
  role: UserRole;
  totp_enabled: unknown;
  disabled: unknown;
  u_created_at: string;
  last_login_at: string | null;
}

/**
 * Resolve a cookie value to a user, refreshing `last_seen_at` and sliding the
 * expiry. Returns null for unknown, expired, or disabled accounts.
 */
export async function resolveSession(
  db: DatabaseAdapter,
  token: string,
  options: { ttlDays: number; now?: Date } = { ttlDays: 7 },
): Promise<ResolvedSession | null> {
  if (!token || token.length < 32) return null;

  const tokenHash = await sha256Hex(token);
  const now = options.now ?? new Date();

  const result = await db.query<SessionUserRow>(
    `SELECT s.id            AS s_id,
            s.user_id       AS user_id,
            s.token_hash    AS token_hash,
            s.created_at    AS s_created_at,
            s.expires_at    AS expires_at,
            s.last_seen_at  AS last_seen_at,
            s.ip            AS ip,
            s.user_agent    AS user_agent,
            u.id            AS u_id,
            u.name          AS name,
            u.email         AS email,
            u.role          AS role,
            u.totp_enabled  AS totp_enabled,
            u.disabled      AS disabled,
            u.created_at    AS u_created_at,
            u.last_login_at AS last_login_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [tokenHash],
  );

  const row = result.rows[0];
  if (!row) return null;

  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    // Opportunistic cleanup — expired rows are useless and only cost reads.
    await db.execute('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]).catch(() => undefined);
    return null;
  }

  if (toBool(row.disabled)) return null;

  // Slide the expiry, but never beyond the absolute lifetime.
  const absoluteCap = new Date(
    new Date(row.s_created_at).getTime() + ABSOLUTE_LIFETIME_DAYS * 86_400_000,
  );
  const nextExpiry = new Date(now.getTime() + options.ttlDays * 86_400_000);
  const newExpiry = nextExpiry < absoluteCap ? nextExpiry : absoluteCap;

  if (newExpiry.getTime() > expiresAt.getTime()) {
    await db
      .execute('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', [
        now.toISOString(),
        newExpiry.toISOString(),
        tokenHash,
      ])
      .catch(() => undefined);
  }

  return {
    session: {
      id: row.s_id,
      user_id: row.user_id,
      token_hash: row.token_hash,
      created_at: row.s_created_at,
      expires_at: newExpiry.toISOString(),
      last_seen_at: now.toISOString(),
      ip: row.ip,
      user_agent: row.user_agent,
    },
    user: toPublicUser({
      id: row.u_id,
      name: row.name,
      email: row.email,
      role: row.role,
      totp_enabled: row.totp_enabled,
      created_at: row.u_created_at,
      last_login_at: row.last_login_at,
    }),
  };
}

export async function destroySession(db: DatabaseAdapter, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db.execute('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}

export async function destroyAllSessions(
  db: DatabaseAdapter,
  userId: string,
): Promise<number> {
  const result = await db.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return result.changes;
}

export async function listSessions(
  db: DatabaseAdapter,
  userId: string,
): Promise<Array<Pick<SessionRow, 'id' | 'created_at' | 'last_seen_at' | 'ip' | 'user_agent'>>> {
  const result = await db.query<SessionRow>(
    `SELECT id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent
       FROM sessions
      WHERE user_id = ?
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    ip: row.ip,
    user_agent: row.user_agent,
  }));
}

/** Housekeeping — run alongside the daily aggregation job. */
export async function cleanupExpiredSessions(db: DatabaseAdapter): Promise<number> {
  const result = await db.execute('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
  return result.changes;
}

export function toPublicUser(row: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  totp_enabled: unknown;
  created_at: string;
  last_login_at: string | null;
}): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    totp_enabled: toBool(row.totp_enabled),
  };
}

/** SQLite hands back 0/1 for BOOLEAN columns; PostgreSQL hands back true/false. */
export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toNumOrZero(value: unknown): number {
  return toNum(value) ?? 0;
}
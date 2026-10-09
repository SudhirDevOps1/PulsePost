import type { Context, MiddlewareHandler } from 'hono';
import { loadConfig, type AppConfig } from '../config.ts';
import { getDb } from '../db/index.ts';
import { ConfigError } from '../db/index.ts';
import {
  resolveSession,
  readSessionCookie,
  type ResolvedSession,
} from '../auth/session.ts';
import { parseAllowlist, isIpAllowed, clientIp, type RequestCf } from '../util/ip.ts';
import type { PublicUser, UserRole } from '../../shared/types.ts';
import { HttpError } from '../http/errors.ts';

export type AppEnv = {
  /** Bindings available to the Worker: DB, HYPERDRIVE, ASSETS, secrets, vars. */
  Bindings: Record<string, unknown> & { ASSETS?: Fetcher };
  Variables: {
    config: AppConfig;
    db: import('../db/types.ts').DatabaseAdapter;
    user: PublicUser | null;
    session: ResolvedSession['session'] | null;
    clientIp: string | undefined;
    dbReady: boolean;
  };
};

export type AppContext = Context<AppEnv>;

/** Adapters we have already logged an "applied migrations" line for. */
const announcedMigrations = new WeakSet<object>();

/**
 * Attach config + a migrated database handle to every request.
 *
 * Database initialisation is wrapped so a misconfigured deployment returns a
 * clear 500 with actionable text, instead of an opaque driver error deep in a
 * route handler.
 */
export function withDatabase(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = loadConfig(c.env as Record<string, unknown>);
    c.set('config', config);
    c.set('clientIp', clientIp(c.req.raw, (c.req.raw as { cf?: RequestCf }).cf));

    try {
      const db = await getDb(c.env as Record<string, unknown>);
      const result = await db.migrate();
      c.set('db', db);
      c.set('dbReady', true);

      // `migrate()` memoises its result for the isolate's lifetime, so
      // `applied` is non-empty on every request after the first. Logging it
      // each time would be misleading — only the first call is a real apply.
      if (!announcedMigrations.has(db)) {
        announcedMigrations.add(db);
        if (result.applied.length > 0) {
          console.log(
            `[db] applied ${result.applied.length} migration(s): ${result.applied.join(', ')} (${result.durationMs}ms)`,
          );
        }
      }
    } catch (error) {
      c.set('dbReady', false);
      const message =
        error instanceof ConfigError
          ? error.message
          : `Database unavailable: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[db] ${message}`);
      return c.json(
        {
          error: 'Database is not configured correctly',
          code: 'DB_UNAVAILABLE',
          details: config.environment === 'production' ? undefined : message,
        },
        503,
      );
    }

    await next();
  };
}

/**
 * Resolve the caller.
 *
 * Three supported modes, selected by `AUTH_MODE`:
 *   - `password` (default) — database sessions via HttpOnly cookie.
 *   - `basic` — HTTP Basic, useful for Docker/local where there is no
 *     interactive login flow worth wiring up.
 *   - `totp` — password login plus a mandatory 6-digit second factor.
 *
 * This middleware never rejects on its own; it only populates
 * `c.get('user')`. Enforcement happens in `requireAuth`, which is applied per
 * route so public status pages stay reachable.
 */
export function resolveIdentity(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = c.get('config');
    c.set('user', null);
    c.set('session', null);

    if (config.authMode === 'basic') {
      const user = await resolveBasic(c, config);
      c.set('user', user);
      await next();
      return;
    }

    const cookie = readSessionCookie(c.req.header('Cookie'));
    if (cookie) {
      try {
        const resolved = await resolveSession(c.get('db'), cookie, {
          ttlDays: config.sessionTtlDays,
        });
        if (resolved) {
          c.set('user', resolved.user);
          c.set('session', resolved.session);
        }
      } catch (error) {
        console.error('[auth] session lookup failed:', error);
      }
    }

    await next();
  };
}

async function resolveBasic(
  c: AppContext,
  config: AppConfig,
): Promise<PublicUser | null> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Basic ')) return null;

  const decoded = decodeBasic(header.slice(6));
  if (!decoded) return null;

  const { username, password } = decoded;
  if (!config.adminUsername || !config.adminPassword) return null;

  // Length-independent comparison, so a wrong username is not distinguishable
  // from a wrong password by response time.
  const usernameOk = timingSafeStringEqual(username, config.adminUsername);
  const passwordOk = timingSafeStringEqual(password, config.adminPassword);

  if (!usernameOk || !passwordOk) return null;

  return {
    id: 'basic-auth',
    name: config.adminUsername,
    email: config.adminUsername,
    role: 'admin',
    created_at: new Date(0).toISOString(),
    last_login_at: null,
    totp_enabled: false,
  };
}

function decodeBasic(value: string): { username: string; password: string } | null {
  try {
    const decoded = atob(value);
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  // Compare a fixed number of characters so the loop length does not depend on
  // where the first difference is.
  const max = Math.max(a.length, b.length, 64);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Generic single-cookie reader.
 *
 * Session cookies should go through `readSessionCookie`, which understands both
 * the `__Host-` and plain names; this remains for any future non-session cookie.
 */
export function getCookie(c: Context, name: string): string | undefined {
  const header = c.req.header('Cookie');
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Enforce authentication and, optionally, a minimum role.
 *
 * Also enforces the admin IP allowlist. The allowlist is checked *before* the
 * credential check so a blocked network learns nothing about whether a given
 * account exists.
 */
export function requireAuth(minimumRole: UserRole = 'viewer'): MiddlewareHandler<AppEnv> {
  const rank: Record<UserRole, number> = { admin: 3, editor: 2, viewer: 1 };

  return async (c, next) => {
    const config = c.get('config');

    if (!isIpAllowed(parseAllowlist(config.adminIpAllowlist), c.get('clientIp'))) {
      return c.json(
        { error: 'Your IP address is not permitted to access the admin API', code: 'IP_BLOCKED' },
        403,
      );
    }

    const user = c.get('user');
    if (!user) {
      // TOTP mode answers with 401 + WWW-Authenticate so a browser shows the
      // native credential prompt; other modes use a JSON 401.
      return c.json(
        { error: 'Authentication required', code: 'UNAUTHORIZED' },
        401,
        config.authMode === 'basic'
          ? { 'WWW-Authenticate': 'Basic realm="PulsePost", charset="UTF-8"' }
          : undefined,
      );
    }

    if (rank[user.role] < rank[minimumRole]) {
      return c.json(
        {
          error: `This action requires the ${minimumRole} role`,
          code: 'FORBIDDEN',
        },
        403,
      );
    }

    await next();
  };
}

/** Attach the resolved user, or 401. Used by read-only authenticated routes. */
export function requireUser(): MiddlewareHandler<AppEnv> {
  return requireAuth('viewer');
}

export { HttpError };
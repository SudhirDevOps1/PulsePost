import { isDBProvider, type DBProvider } from './db/types.ts';

/**
 * Central environment configuration.
 *
 * Rules this module enforces:
 *   - Secrets are only ever read from env vars that came from
 *     `wrangler secret put` / `.dev.vars`. Nothing here has a default secret.
 *   - Non-secret switches (`DB_PROVIDER`, limits, retention) are plain vars
 *     declared in `wrangler.toml` and are safe to commit.
 *   - Everything is parsed defensively: a malformed limit must not crash the
 *     Worker on a cold start, it must fall back to a sane default.
 */

export type Environment = 'development' | 'production' | 'test';
export type AuthMode = 'password' | 'basic' | 'totp';

export interface AppConfig {
  dbProvider: DBProvider;
  environment: Environment;
  appName: string;
  version: string;

  corsOrigins: string[];
  adminIpAllowlist: string[];

  authMode: AuthMode;
  allowPrivateTargets: boolean;
  sessionTtlDays: number;

  authRateLimit: number;
  apiRateLimit: number;
  rateWindowSeconds: number;

  checksPerRun: number;
  checkColos: string[];
  rawCheckRetentionDays: number;
  dailyStatusRetentionDays: number;
  maintenanceHourUtc: number;

  // --- secrets (never logged, never returned from any endpoint) ---
  cronSecret: string | undefined;
  adminUsername: string | undefined;
  adminPassword: string | undefined;
  totpSecret: string | undefined;

  // --- database connection strings ---
  tursoUrl: string | undefined;
  tursoAuthToken: string | undefined;
  neonUrl: string | undefined;
  neonPoolerUrl: string | undefined;
  supabaseUrl: string | undefined;
  databaseUrl: string | undefined;
}

type Env = Record<string, unknown>;

export function loadConfig(env: Env): AppConfig {
  const environment = str(env.ENVIRONMENT, 'production') as Environment;
  const isDev = environment === 'development';

  return {
    dbProvider: isDBProvider(env.DB_PROVIDER) ? env.DB_PROVIDER : 'd1',

    environment,
    appName: str(env.APP_NAME, 'PulsePost'),
    version: str(env.APP_VERSION, '1.0.0'),

    corsOrigins: csv(str(env.CORS_ORIGINS, '')),
    adminIpAllowlist: csv(str(env.ADMIN_IP_ALLOWLIST, '')),

    authMode: (['password', 'basic', 'totp'].includes(str(env.AUTH_MODE, 'password'))
      ? str(env.AUTH_MODE, 'password')
      : 'password') as AuthMode,
    /**
     * Permit monitoring private/loopback/link-local targets.
     *
     * Deliberately NOT inferred from `ENVIRONMENT`: tying a security control to
     * an unrelated switch means any misconfiguration silently disables SSRF
     * protection. This defaults to off everywhere, and the Docker/local setup
     * script opts in explicitly.
     */
    allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),

    sessionTtlDays: int(env.SESSION_TTL_DAYS, 7, 1, 90),

    // Fallback budgets used only when the Workers rate limiting binding is
    // absent (wrangler dev, Docker, tests). The binding's own limit wins when
    // it is configured, since it is edge-accurate.
    authRateLimit: int(env.AUTH_RATE_LIMIT, 5, 1, 1000),
    apiRateLimit: int(env.API_RATE_LIMIT, 300, 1, 100_000),
    rateWindowSeconds: int(env.RATE_WINDOW_SECONDS, 60, 1, 3600),

    // Cloudflare's free plan allows 50 subrequests per cron invocation, and a
    // failing monitor also spends one on its notification. 20 leaves headroom.
    checksPerRun: int(env.CHECKS_PER_RUN, 20, 1, 45),
    checkColos: csv(str(env.CHECK_COLOS, '')),
    rawCheckRetentionDays: int(env.RAW_CHECK_RETENTION_DAYS, 7, 1, 90),
    dailyStatusRetentionDays: int(env.DAILY_STATUS_RETENTION_DAYS, 365, 30, 3650),
    maintenanceHourUtc: int(env.MAINTENANCE_HOUR_UTC, 0, 0, 23),

    cronSecret: str(env.CRON_SECRET, '') || undefined,
    adminUsername: str(env.ADMIN_USERNAME, '') || undefined,
    adminPassword: str(env.ADMIN_PASSWORD, '') || undefined,
    totpSecret: str(env.TOTP_SECRET, '') || undefined,

    tursoUrl: str(env.TURSO_DATABASE_URL, '') || undefined,
    tursoAuthToken: str(env.TURSO_AUTH_TOKEN, '') || undefined,
    neonUrl: str(env.NEON_DATABASE_URL, '') || undefined,
    neonPoolerUrl: str(env.NEON_DATABASE_URL_POOLER, '') || undefined,
    supabaseUrl: str(env.SUPABASE_DATABASE_URL, '') || undefined,
    databaseUrl: str(env.DATABASE_URL, '') || undefined,
  };
}

/**
 * Configuration errors the caller must surface loudly rather than silently
 * degrading — a wrong DB setting would otherwise manifest as a confusing
 * 500 much later.
 */
export function validateConfig(config: AppConfig): string[] {
  const problems: string[] = [];

  switch (config.dbProvider) {
    case 'd1':
      break;
    case 'turso':
      if (!config.tursoUrl) problems.push('DB_PROVIDER=turso requires TURSO_DATABASE_URL');
      if (!config.tursoAuthToken)
        problems.push('DB_PROVIDER=turso requires TURSO_AUTH_TOKEN');
      break;
    case 'neon':
      if (!config.neonUrl && !config.neonPoolerUrl)
        problems.push('DB_PROVIDER=neon requires NEON_DATABASE_URL or NEON_DATABASE_URL_POOLER');
      break;
    case 'supabase':
      if (!config.supabaseUrl) problems.push('DB_PROVIDER=supabase requires SUPABASE_DATABASE_URL');
      if (config.supabaseUrl && config.supabaseUrl.includes('.supabase.co:5432'))
        problems.push(
          'Supabase direct connection is IPv6-only and unreachable from Workers — use the pooler on port 6543',
        );
      break;
    case 'hyperdrive':
      // Credentials come from the binding, so nothing to validate here.
      break;
    case 'sqlite':
      if (!config.databaseUrl) problems.push('DB_PROVIDER=sqlite requires DATABASE_URL');
      break;
  }

  if (config.authMode === 'basic' && (!config.adminUsername || !config.adminPassword)) {
    problems.push('AUTH_MODE=basic requires ADMIN_USERNAME and ADMIN_PASSWORD');
  }

  return problems;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * Parse an integer env var.
 *
 * Accepts numbers as well as strings: Cloudflare always supplies strings, but
 * `.env` loaders, test harnesses and Docker compose often hand over real
 * numbers, and silently falling back to the default for those would be a
 * nasty, invisible bug.
 */
function int(value: unknown, fallback: number, min: number, max: number): number {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number.parseInt(value, 10);
  } else {
    return fallback;
  }

  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * Parse a boolean env var.
 * Accepts real booleans as well as the usual textual spellings, because
 * `.env` loaders and Docker compose differ on quoting.
 */
function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
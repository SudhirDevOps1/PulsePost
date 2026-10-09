import { loadConfig, validateConfig, type AppConfig } from './../config.ts';
import type { AppConfig as _AppConfig } from './../config.ts';
import { D1Adapter, type D1Like } from './providers/d1.ts';
import { LibsqlAdapter } from './providers/libsql.ts';
import { NeonAdapter } from './providers/neon.ts';
import { PostgresAdapter } from './providers/postgres.ts';
import type { DatabaseAdapter } from './types.ts';

export * from './types.ts';
export { nowIso, todayIso } from './dialect.ts';

type Env = Record<string, unknown>;

/**
 * One adapter per (provider, config) for the lifetime of the isolate.
 *
 * Cached on `globalThis` rather than in a module variable on purpose: a
 * Cloudflare isolate can be reused across requests, but bundling may also
 * evaluate the module more than once per isolate. Keying on the connection
 * details keeps `wrangler dev` reloads from reusing a stale adapter.
 */
interface CacheEntry {
  key: string;
  adapter: DatabaseAdapter;
}

const globalCache = globalThis as unknown as { __pulsepostDb?: CacheEntry };

/**
 * Get the adapter for this environment, creating and auto-migrating it on
 * first use.
 */
export async function getDb(env: Env): Promise<DatabaseAdapter> {
  const config = loadConfig(env);
  const adapter = await resolveAdapter(config, env);
  await adapter.connect();
  return adapter;
}

/** Like {@link getDb} but without running migrations. Used by health checks. */
export async function getDbWithoutMigration(env: Env): Promise<DatabaseAdapter> {
  const config = loadConfig(env);
  const adapter = await resolveAdapter(config, env);
  await adapter.connect();
  return adapter;
}

async function resolveAdapter(config: AppConfig, env: Env): Promise<DatabaseAdapter> {
  const key = cacheKey(config, env);
  const cached = globalCache.__pulsepostDb;
  if (cached && cached.key === key) return cached.adapter;

  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  const adapter = await create(config, env);
  globalCache.__pulsepostDb = { key, adapter };
  return adapter;
}

/**
 * Apply pending migrations. Safe to call on every request — the adapter
 * deduplicates concurrent calls and only applies missing versions.
 */
export async function ensureMigrated(adapter: DatabaseAdapter) {
  return adapter.migrate();
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Database configuration is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

async function create(config: AppConfig, env: Env): Promise<DatabaseAdapter> {
  switch (config.dbProvider) {
    case 'd1': {
      const binding = env.DB as D1Like | undefined;
      if (!binding) {
        throw new ConfigError([
          'DB_PROVIDER=d1 but no `DB` binding exists in wrangler.toml',
        ]);
      }
      return new D1Adapter(binding);
    }

    case 'turso':
      return LibsqlAdapter.create('turso', {
        url: config.tursoUrl!,
        authToken: config.tursoAuthToken,
      });

    case 'sqlite':
      return LibsqlAdapter.create('sqlite', { url: config.databaseUrl! });

    case 'neon': {
      // The direct endpoint uses WebSockets and is the lower-latency path from
      // Workers; the pooler is a safe fallback if only that was configured.
      const connectionString = config.neonUrl ?? config.neonPoolerUrl!;
      return NeonAdapter.create(connectionString);
    }

    case 'supabase':
      return PostgresAdapter.create('supabase', config.supabaseUrl!);

    case 'hyperdrive': {
      const binding = env.HYPERDRIVE as { connectionString?: string } | undefined;
      if (!binding?.connectionString) {
        throw new ConfigError([
          'DB_PROVIDER=hyperdrive but no `HYPERDRIVE` binding exists in wrangler.toml',
        ]);
      }
      return PostgresAdapter.create('hyperdrive', binding.connectionString);
    }

    default: {
      const exhaustive: never = config.dbProvider;
      throw new ConfigError([`Unsupported DB_PROVIDER: ${String(exhaustive)}`]);
    }
  }
}

function cacheKey(config: AppConfig, env: Env): string {
  switch (config.dbProvider) {
    case 'd1':
      // D1 is identified by its binding identity, not by URL.
      return `d1:${identityOf(env.DB)}`;
    case 'turso':
      return `turso:${config.tursoUrl}`;
    case 'sqlite':
      return `sqlite:${config.databaseUrl}`;
    case 'neon':
      return `neon:${config.neonUrl ?? config.neonPoolerUrl}`;
    case 'supabase':
      return `supabase:${redactUrl(config.supabaseUrl)}`;
    case 'hyperdrive':
      return `hyperdrive:${identityOf(env.HYPERDRIVE)}`;
    default:
      return `unknown:${String(config.dbProvider)}`;
  }
}

function identityOf(binding: unknown): string {
  if (!binding) return 'missing';
  return String((binding as { databaseId?: string; id?: string }).databaseId ?? 'bound');
}

/** Strip the password so a cache key never lands in a log. */
function redactUrl(url: string | undefined): string {
  if (!url) return 'missing';
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.toString();
  } catch {
    return 'invalid';
  }
}

export type { _AppConfig as AppConfig };
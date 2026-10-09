import { BaseAdapter } from '../base.ts';
import { prepare } from '../dialect.ts';
import type {
  DatabaseAdapter,
  DBProvider,
  HealthReport,
  QueryMeta,
  QueryResult,
  Statement,
} from '../types.ts';

/**
 * PostgreSQL via postgres.js — serves Supabase and Hyperdrive.
 *
 *  - Supabase direct connections are IPv6-only and unreachable from Workers, so
 *    the pooler host (`:6543`) is required. `setup.sh` enforces this.
 *  - Hyperdrive injects its own pooled credentials at runtime, so we read the
 *    connection string off the binding rather than from an env var, and no
 *    database secret ever reaches the Worker.
 *
 * postgres.js is used for both because Hyperdrive speaks the Postgres wire
 * protocol over HTTP, which postgres.js speaks natively.
 */

/** Structural view of the postgres.js tagged-template client. */
export interface PostgresSql {
  unsafe<R extends unknown[] = unknown[]>(
    query: string,
    params?: unknown[],
  ): Promise<R & { count: number }>;
  begin<T>(fn: (tx: PostgresSql) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
}

export interface PostgresJsModule {
  default: (connectionString: string, options?: Record<string, unknown>) => PostgresSql;
}

const INT8_OID = 20;

/**
 * postgres.js returns an array-like result carrying `.count` (rows affected).
 * Read it defensively: the shape differs slightly between versions, and a
 * missing count must not throw.
 */
function resultMeta(result: unknown): QueryMeta {
  const count =
    result && typeof result === 'object' && 'count' in result
      ? Number((result as { count?: unknown }).count)
      : 0;

  return {
    changes: Number.isFinite(count) ? count : 0,
    lastInsertRowId: undefined,
    durationMs: undefined,
  };
}

export class PostgresAdapter extends BaseAdapter {
  readonly dialect = 'postgres' as const;
  readonly provider: DBProvider;

  private readonly sql: PostgresSql;

  constructor(provider: 'supabase' | 'hyperdrive', sql: PostgresSql) {
    super();
    this.provider = provider;
    this.sql = sql;
  }

  static async create(
    provider: 'supabase' | 'hyperdrive',
    connectionString: string,
  ): Promise<PostgresAdapter> {
    const postgresModule = (await import('postgres')) as unknown as PostgresJsModule;

    const sql = postgresModule.default(connectionString, {
      // A Workers isolate handles one request at a time; a bigger pool only
      // burns Neon/Supabase connection budget.
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      // postgres.js prepared-statement caching fights Hyperdrive's pooling.
      prepare: false,
      // int8 (bigint) -> number. postgres.js returns 64-bit ints as strings by
      // default; our counters always fit in a double, and a stray `"42"` in a
      // JSON response is a real bug. postgres.js merges `user.parsers` *after*
      // its built-ins (Object.assign({}, parsers, user.parsers)), so this wins.
      types: {
        [INT8_OID]: { to: INT8_OID, from: [INT8_OID], parse: (value: string) => Number(value) },
      },
    });

    return new PostgresAdapter(provider, sql);
  }

  override async connect(): Promise<void> {
    if (this.connected) return;
    await this.sql.unsafe('SELECT 1');
    this.connected = true;
  }

  override async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const prepared = prepare(sql, params, this.dialect);
    const rows = await this.sql.unsafe<unknown[]>(prepared.sql, prepared.params);
    return { rows: rows as T[], meta: resultMeta(rows) };
  }

  override async execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta> {
    const prepared = prepare(sql, params, this.dialect);
    const rows = await this.sql.unsafe<unknown[]>(prepared.sql, prepared.params);
    return resultMeta(rows);
  }

  override async batch(statements: readonly Statement[]): Promise<QueryMeta[]> {
    if (statements.length === 0) return [];
    // `begin` gives us a real transaction; batch() must be atomic.
    return this.sql.begin(async (tx) => {
      const metas: QueryMeta[] = [];
      for (const statement of statements) {
        const prepared = prepare(statement.sql, statement.params, this.dialect);
        metas.push(resultMeta(await tx.unsafe<unknown[]>(prepared.sql, prepared.params)));
      }
      return metas;
    });
  }

  override async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.sql.begin(async (txSql) => fn(new PostgresTxAdapter(this.provider, txSql)));
  }

  override async healthCheck(): Promise<HealthReport> {
    const startedAt = Date.now();
    try {
      const rows = await this.sql.unsafe<Array<{ version: string }>>('SELECT version() AS version');
      return {
        ok: true,
        provider: this.provider,
        dialect: this.dialect,
        latencyMs: Date.now() - startedAt,
        serverVersion: rows[0]?.version?.slice(0, 40),
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.provider,
        dialect: this.dialect,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async close(): Promise<void> {
    await this.sql.end({ timeout: 2 });
    this.connected = false;
  }
}

class PostgresTxAdapter extends BaseAdapter {
  readonly dialect = 'postgres' as const;
  readonly provider: DBProvider;

  private readonly sql: PostgresSql;

  constructor(provider: DBProvider, sql: PostgresSql) {
    super();
    this.provider = provider;
    this.sql = sql;
    this.connected = true;
  }

  override async connect(): Promise<void> {
    this.connected = true;
  }

  override async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const prepared = prepare(sql, params, this.dialect);
    const rows = await this.sql.unsafe<unknown[]>(prepared.sql, prepared.params);
    return { rows: rows as T[], meta: resultMeta(rows) };
  }

  override async execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta> {
    const prepared = prepare(sql, params, this.dialect);
    const rows = await this.sql.unsafe<unknown[]>(prepared.sql, prepared.params);
    return resultMeta(rows);
  }

  override async batch(statements: readonly Statement[]): Promise<QueryMeta[]> {
    const metas: QueryMeta[] = [];
    for (const statement of statements) {
      metas.push(await this.execute(statement.sql, statement.params));
    }
    return metas;
  }

  override async transaction<T>(_fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    throw new Error('Nested transactions are not supported');
  }

  override async healthCheck(): Promise<HealthReport> {
    return { ok: true, provider: this.provider, dialect: this.dialect, latencyMs: 0 };
  }
}
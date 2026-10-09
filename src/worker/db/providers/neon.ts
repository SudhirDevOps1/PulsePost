import { BaseAdapter } from '../base.ts';
import { prepare } from '../dialect.ts';
import type {
  DatabaseAdapter,
  HealthReport,
  QueryMeta,
  QueryResult,
  Statement,
} from '../types.ts';

/**
 * Neon (Serverless Postgres) over WebSocket.
 *
 * Neon is reached over a WebSocket rather than TCP, which is exactly why it
 * works from Cloudflare Workers: workerd exposes a global `WebSocket` and no
 * outbound TCP sockets.
 *
 * `pg`'s default type parser hands `int8` (bigint) back as a *string* so that
 * 64-bit precision survives. Our counts comfortably fit in a double, and a
 * `"42"` leaking into the API would be a nasty bug, so OID 20 is parsed to a
 * number. Queries additionally use explicit `CAST(... AS INTEGER)` for
 * aggregates so the result is correct regardless of driver defaults.
 */

/** Structural view of the `pg` client interface we depend on. */
export interface PgQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
  command: string;
}

export interface PgClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  release(): void;
}

export interface PgPool {
  connect(): Promise<PgClient>;
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  end(): Promise<void>;
  totalCount?: number;
  idleCount?: number;
}

/** Shape of the `types` export on @neondatabase/serverless. */
interface PgTypesModule {
  types: {
    getTypeParser(oid: number, format?: unknown): (value: string) => unknown;
  };
}

const INT8_OID = 20;

function toMeta(result: { rowCount: number | null }): QueryMeta {
  return {
    changes: result.rowCount ?? 0,
    lastInsertRowId: undefined,
    durationMs: undefined,
  };
}

export class NeonAdapter extends BaseAdapter {
  readonly dialect = 'postgres' as const;
  readonly provider = 'neon' as const;

  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    super();
    this.pool = pool;
  }

  static async create(connectionString: string): Promise<NeonAdapter> {
    const neon = (await import('@neondatabase/serverless')) as unknown as Record<string, unknown>;

    const config = neon.neonConfig as Record<string, unknown>;

    // Workers has no `ws` module, so point the driver at the global
    // WebSocket and derive the regional endpoint from the connection host.
    config.webSocketConstructor = WebSocket;
    config.useSecureWebSocket = true;
    config.fetchConnectionCache = true;
    config.poolQueryViaFetch = true;

    const host = safeHost(connectionString);
    if (host) config.wsEndpoint = `wss://${host}`;

    const baseParser = (neon as unknown as PgTypesModule).types.getTypeParser;
    const PoolCtor = neon.Pool as new (options: Record<string, unknown>) => unknown;

    const pool = new PoolCtor({
      connectionString,
      max: 2, // Workers isolates are short-lived; a larger pool just wastes resources
      idleTimeoutMillis: 10_000,
      types: {
        // int8 -> number, see the note above. Everything else falls through to
        // the driver's own parser.
        getTypeParser(oid: number, format?: unknown) {
          if (oid === INT8_OID) return (value: string) => Number(value);
          return baseParser(oid, format);
        },
      },
    });

    return new NeonAdapter(pool as PgPool);
  }

  override async connect(): Promise<void> {
    if (this.connected) return;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    this.connected = true;
  }

  override async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const prepared = prepare(sql, params, this.dialect);
    const result = await this.pool.query<T>(prepared.sql, prepared.params);
    return { rows: result.rows, meta: toMeta(result) };
  }

  override async execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta> {
    const prepared = prepare(sql, params, this.dialect);
    const result = await this.pool.query(prepared.sql, prepared.params);
    return toMeta(result);
  }

  override async batch(statements: readonly Statement[]): Promise<QueryMeta[]> {
    if (statements.length === 0) return [];
    const client = await this.pool.connect();
    const metas: QueryMeta[] = [];
    try {
      await client.query('BEGIN');
      try {
        for (const statement of statements) {
          const prepared = prepare(statement.sql, statement.params, this.dialect);
          const result = await client.query(prepared.sql, prepared.params);
          metas.push(toMeta(result));
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
    return metas;
  }

  override async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new NeonTxAdapter(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  override async healthCheck(): Promise<HealthReport> {
    const startedAt = Date.now();
    try {
      const result = await this.query<{ ok: number; version?: string }>(
        'SELECT 1 AS ok, version() AS version',
      );
      return {
        ok: true,
        provider: this.provider,
        dialect: this.dialect,
        latencyMs: Date.now() - startedAt,
        serverVersion: result.rows[0]?.version?.slice(0, 40),
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
    await this.pool.end();
    this.connected = false;
  }
}

class NeonTxAdapter extends BaseAdapter {
  readonly dialect = 'postgres' as const;
  readonly provider = 'neon' as const;

  private readonly client: PgClient;

  constructor(client: PgClient) {
    super();
    this.client = client;
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
    const result = await this.client.query<T>(prepared.sql, prepared.params);
    return { rows: result.rows, meta: toMeta(result) };
  }

  override async execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta> {
    const prepared = prepare(sql, params, this.dialect);
    return toMeta(await this.client.query(prepared.sql, prepared.params));
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

/** Extract `host` from a `postgresql://user:pass@host/db` URL, or null. */
function safeHost(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    return url.host || null;
  } catch {
    return null;
  }
}
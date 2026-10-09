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
 * Structural view of `@libsql/client`.
 *
 * One implementation serves two providers:
 *   - `turso`  → remote libSQL over HTTPS (`libsql://…`)
 *   - `sqlite` → local file for dev/Docker (`file:./data/pulsepost.db`)
 *
 * They are the same wire format and the same SQLite engine, so there is no
 * reason to maintain two adapters.
 */

export interface LibsqlColumn {
  name: string;
  type: string;
}

/**
 * Rows come back keyed by column name in current @libsql/client. Older builds
 * returned array-like rows, so the type allows both and `toRows` normalises.
 */
export type LibsqlRow = Record<string, unknown> & Record<number, unknown>;

export interface LibsqlResultSet {
  columns: Array<string | LibsqlColumn>;
  rows: LibsqlRow[];
  rowsAffected: number;
  lastInsertRowid?: number | bigint | null;
}

export interface LibsqlStatement {
  sql: string;
  args?: unknown[];
}

export interface LibsqlExecutor {
  execute(stmt: LibsqlStatement): Promise<LibsqlResultSet>;
  batch(stmts: LibsqlStatement[], mode?: 'write' | 'read'): Promise<LibsqlResultSet[]>;
  transaction(mode?: 'write' | 'read'): Promise<LibsqlTransaction>;
  close(): void;
}

export interface LibsqlTransaction extends LibsqlExecutor {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface LibsqlClient extends LibsqlExecutor {
  close(): void;
}

/**
 * Normalise rows to plain keyed objects.
 *
 * `columns` is `string[]` in current @libsql/client, but older builds exposed
 * `{ name, type }` objects and returned array-like rows. Both shapes are
 * handled so a driver upgrade cannot silently turn every column name into
 * `undefined` — which is exactly the failure this guards against.
 */
function toRows<T>(result: LibsqlResultSet): T[] {
  const rows = result.rows;
  if (rows.length === 0) return [];

  const names = (result.columns ?? []).map((column) =>
    typeof column === 'string' ? column : column.name,
  );

  const first = rows[0]!;
  const alreadyKeyed = names.length > 0 && names.every((name) => name in first);
  if (alreadyKeyed) return rows as unknown as T[];

  return rows.map((row) => {
    const object: Record<string, unknown> = {};
    names.forEach((name, index) => {
      if (name) object[name] = row[index];
    });
    return object as T;
  });
}

function toMeta(result: LibsqlResultSet): QueryMeta {
  return {
    changes: result.rowsAffected,
    lastInsertRowId: result.lastInsertRowid ?? undefined,
    durationMs: undefined,
  };
}

export class LibsqlAdapter extends BaseAdapter {
  readonly dialect = 'sqlite' as const;
  readonly provider: DBProvider;

  private readonly client: LibsqlClient;

  constructor(provider: 'turso' | 'sqlite', client: LibsqlClient) {
    super();
    this.provider = provider;
    this.client = client;
  }

  static async create(
    provider: 'turso' | 'sqlite',
    options: { url: string; authToken?: string },
  ): Promise<LibsqlAdapter> {
    // Imported lazily so the Workers bundle never pulls in the native/TLS
    // paths that only matter for local files.
    const { createClient } = await import('@libsql/client');
    const client = createClient({
      url: options.url,
      ...(options.authToken ? { authToken: options.authToken } : {}),
    }) as unknown as LibsqlClient;
    return new LibsqlAdapter(provider, client);
  }

  override async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.execute({ sql: 'SELECT 1' });
    this.connected = true;
  }

  private prep(sql: string, params?: readonly unknown[]): LibsqlStatement {
    const prepared = prepare(sql, params, this.dialect);
    return { sql: prepared.sql, args: prepared.params };
  }

  override async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const result = await this.client.execute(this.prep(sql, params));
    return { rows: toRows<T>(result), meta: toMeta(result) };
  }

  override async execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta> {
    const result = await this.client.execute(this.prep(sql, params));
    return toMeta(result);
  }

  override async batch(statements: readonly Statement[]): Promise<QueryMeta[]> {
    if (statements.length === 0) return [];
    const results = await this.client.batch(
      statements.map((s) => this.prep(s.sql, s.params)),
      'write',
    );
    return results.map(toMeta);
  }

  override async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    const handle = await this.client.transaction('write');
    try {
      const result = await fn(new LibsqlTxAdapter(this.provider, handle));
      await handle.commit();
      return result;
    } catch (error) {
      try {
        await handle.rollback();
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    }
  }

  override async healthCheck(): Promise<HealthReport> {
    const startedAt = Date.now();
    try {
      const result = await this.query<{ ok: number }>('SELECT 1 AS ok');
      return {
        ok: result.rows.length > 0,
        provider: this.provider,
        dialect: this.dialect,
        latencyMs: Date.now() - startedAt,
        serverVersion: `libsql:${this.provider}`,
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
    this.client.close();
    this.connected = false;
  }
}

/** Transaction-scoped view handed to `transaction()` callbacks. */
class LibsqlTxAdapter extends BaseAdapter {
  readonly dialect = 'sqlite' as const;
  readonly provider: DBProvider;

  private readonly handle: LibsqlTransaction;

  constructor(provider: DBProvider, handle: LibsqlTransaction) {
    super();
    this.provider = provider;
    this.handle = handle;
    this.connected = true;
  }

  override async connect(): Promise<void> {
    this.connected = true;
  }

  private prep(sql: string, params?: readonly unknown[]): LibsqlStatement {
    const prepared = prepare(sql, params, this.dialect);
    return { sql: prepared.sql, args: prepared.params };
  }

  override async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const result = await this.handle.execute(this.prep(sql, params));
    return { rows: toRows<T>(result), meta: toMeta(result) };
  }

  override async execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta> {
    return toMeta(await this.handle.execute(this.prep(sql, params)));
  }

  override async batch(statements: readonly Statement[]): Promise<QueryMeta[]> {
    if (statements.length === 0) return [];
    const results = await this.handle.batch(
      statements.map((s) => this.prep(s.sql, s.params)),
      'write',
    );
    return results.map(toMeta);
  }

  override async transaction<T>(_fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    throw new Error('Nested transactions are not supported');
  }

  override async healthCheck(): Promise<HealthReport> {
    return {
      ok: true,
      provider: this.provider,
      dialect: this.dialect,
      latencyMs: 0,
      serverVersion: 'transaction',
    };
  }
}
import { BaseAdapter } from './../base.ts';
import { prepare } from './../dialect.ts';
import type {
  DatabaseAdapter,
  HealthReport,
  QueryMeta,
  QueryResult,
  Statement,
} from './../types.ts';

/**
 * Minimal structural view of the D1 binding.
 * Declared locally so the project typechecks without pulling the full
 * `@cloudflare/workers-types` surface into every file.
 */
export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec?(sql: string): Promise<{ count: number; duration: number }>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: unknown; success?: boolean }>;
  run(): Promise<{ meta?: unknown; success?: boolean }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
  duration?: number;
}

/**
 * Cloudflare D1.
 *
 * Notes specific to D1:
 *   - It rejects `BEGIN` / `COMMIT`; `batch()` is the atomic unit instead.
 *   - Booleans *are* bindable here, but we still normalise to 0/1 so that the
 *     identical SQL works on the other SQLite providers.
 *   - `all()` returns `results`, not `rows`.
 */
export class D1Adapter extends BaseAdapter {
  readonly dialect = 'sqlite' as const;
  readonly provider = 'd1' as const;

  private readonly db: D1Like;

  constructor(db: D1Like) {
    super();
    this.db = db;
  }

  override async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
  }

  private stmt(sql: string, params?: readonly unknown[]) {
    const prepared = prepare(sql, params, this.dialect);
    // D1's bind() is variadic; an empty variadic call is fine.
    return prepared.params.length > 0
      ? this.db.prepare(prepared.sql).bind(...prepared.params)
      : this.db.prepare(prepared.sql);
  }

  override async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const result = await this.stmt(sql, params).all<T>();
    return {
      rows: (result.results ?? []) as T[],
      meta: toMeta(result.meta as D1Meta | undefined),
    };
  }

  override async execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta> {
    const result = await this.stmt(sql, params).run();
    return toMeta(result.meta as D1Meta | undefined);
  }

  override async batch(statements: readonly Statement[]): Promise<QueryMeta[]> {
    const prepared = statements.map((s) => this.stmt(s.sql, s.params));
    const results = await this.db.batch(prepared);
    return results.map((r) => toMeta(r.meta as D1Meta | undefined));
  }

  override async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    // D1 has no explicit transaction statements; batch() is atomic.
    return fn(this);
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
        serverVersion: 'd1',
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
}

function toMeta(meta: D1Meta | undefined): QueryMeta {
  return {
    changes: meta?.changes ?? 0,
    lastInsertRowId: meta?.last_row_id,
    durationMs: meta?.duration,
  };
}
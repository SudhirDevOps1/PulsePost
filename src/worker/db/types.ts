/**
 * Database abstraction contracts.
 *
 * The application never talks to a driver directly — it talks to a
 * `DatabaseAdapter`. Six providers collapse onto two SQL dialects
 * (sqlite | postgres) behind this one interface, so switching databases is
 * purely an `DB_PROVIDER` environment change with no code edits.
 */

export type DBProvider =
  | 'd1'
  | 'turso'
  | 'neon'
  | 'supabase'
  | 'hyperdrive'
  | 'sqlite';

export type Dialect = 'sqlite' | 'postgres';

export const DB_PROVIDERS: readonly DBProvider[] = [
  'd1',
  'turso',
  'neon',
  'supabase',
  'hyperdrive',
  'sqlite',
];

export function isDBProvider(value: unknown): value is DBProvider {
  return typeof value === 'string' && (DB_PROVIDERS as readonly string[]).includes(value);
}

/** A single bound statement. */
export interface Statement {
  sql: string;
  params?: readonly unknown[];
}

export interface QueryMeta {
  /** Rows affected. D1/Turso/PG all report this. */
  changes: number;
  /** Last inserted row id, when the driver can supply it. */
  lastInsertRowId: number | bigint | undefined;
  /** Server-reported duration, when available. */
  durationMs: number | undefined;
}

export interface QueryResult<T> {
  rows: T[];
  meta: QueryMeta;
}

export interface HealthReport {
  ok: boolean;
  provider: DBProvider;
  dialect: Dialect;
  latencyMs: number;
  /** D1 database name, PG server version, etc. */
  serverVersion?: string;
  error?: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  durationMs: number;
}

/**
 * The interface every provider implements.
 *
 * Keep it deliberately small — six drivers have to satisfy it, and every
 * method here is on the hot path for the Workers free-tier CPU budget
 * (10 ms/request).
 */
export interface DatabaseAdapter {
  readonly provider: DBProvider;
  readonly dialect: Dialect;

  /** Create the driver/connection. Safe to call more than once. */
  connect(): Promise<void>;

  /** Parameterised SELECT. Returns zero or more rows. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;

  /** Parameterised INSERT/UPDATE/DELETE/DDL. */
  execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta>;

  /**
   * Execute several statements as one unit.
   * Implementations MUST make this atomic: either all statements land or none do.
   */
  batch(statements: readonly Statement[]): Promise<QueryMeta[]>;

  /** Run `fn` inside a transaction, committing on resolve and rolling back on throw. */
  transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>;

  /** Apply any pending bundled migrations. Idempotent. */
  migrate(): Promise<MigrationResult>;

  /** Round-trip a trivial query and report timing. Used by /api/health and setup. */
  healthCheck(): Promise<HealthReport>;

  /** Release sockets/handles. */
  close(): Promise<void>;
}
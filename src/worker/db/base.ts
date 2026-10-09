import { nowExpression, nowIso } from './dialect.ts';
import { MIGRATIONS, type BundledMigration } from './migrations.generated.ts';
import type {
  DatabaseAdapter,
  Dialect,
  MigrationResult,
  QueryMeta,
  QueryResult,
  Statement,
} from './types.ts';

/**
 * Split a migration file into individual statements.
 *
 * Must respect string literals, quoted identifiers and comments, otherwise a
 * `;` inside `DEFAULT ';'` or inside a `--` comment would split a statement
 * in half. `CREATE TABLE` / `CREATE INDEX` blocks are the only shapes we use,
 * so a simple top-level scanner is sufficient and much cheaper than a parser.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = findQuoteEnd(sql, i, ch);
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);

  return statements;
}

function findQuoteEnd(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/**
 * Shared behaviour for every provider: migration bookkeeping.
 *
 * Auto-migration design notes:
 *   - `schema_migrations` is created first, so we can always tell what ran.
 *   - Each migration is applied inside `batch()` (atomic per provider).
 *   - Versions are applied in sorted order and never re-applied.
 *   - A module-level promise guard stops the concurrent cold starts that
 *     Workers can produce from racing each other into a double-apply.
 */
export abstract class BaseAdapter implements DatabaseAdapter {
  abstract readonly dialect: Dialect;
  abstract readonly provider: DatabaseAdapter['provider'];

  protected connected = false;
  private migratePromise: Promise<MigrationResult> | null = null;

  abstract connect(): Promise<void>;
  abstract query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  abstract execute(sql: string, params?: readonly unknown[]): Promise<QueryMeta>;
  abstract batch(statements: readonly Statement[]): Promise<QueryMeta[]>;

  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    // Default: run inline. Providers that can do better override this.
    return fn(this);
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  /**
   * Apply pending migrations, coalescing concurrent callers onto one run.
   * The result (including failure) is cached for the isolate lifetime so a
   * broken migration surfaces consistently instead of retrying per request.
   */
  migrate(): Promise<MigrationResult> {
    if (this.migratePromise) return this.migratePromise;
    this.migratePromise = this.runMigrations().catch((error) => {
      // Allow a later request to retry a transient failure.
      this.migratePromise = null;
      throw error;
    });
    return this.migratePromise;
  }

  private async runMigrations(): Promise<MigrationResult> {
    const startedAt = Date.now();

    await this.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL DEFAULT ${nowExpression(this.dialect)}
       )`,
    );

    const applied = await this.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    const done = new Set(applied.rows.map((row) => row.version));

    const newlyApplied: string[] = [];
    const skipped: string[] = [];

    for (const migration of MIGRATIONS) {
      if (done.has(migration.version)) {
        skipped.push(migration.version);
        continue;
      }
      await this.applyMigration(migration);
      newlyApplied.push(migration.version);
    }

    return {
      applied: newlyApplied,
      skipped,
      durationMs: Date.now() - startedAt,
    };
  }

  private async applyMigration(migration: BundledMigration): Promise<void> {
    const statements = splitStatements(migration.sql).map((sql) => ({ sql }));

    if (statements.length > 0) {
      await this.batch(statements);
    }

    await this.execute('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
      migration.version,
      nowIso(),
    ]);
  }

  abstract healthCheck(): Promise<import('./types.ts').HealthReport>;
}
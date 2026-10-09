import type { Dialect } from './types.ts';

/**
 * Dialect translation layer.
 *
 * Everything that differs between SQLite and PostgreSQL lives here, so the
 * schema in `migrations/*.sql` and every query in the app can be written once.
 *
 * Three things actually differ:
 *
 *  1. Placeholders — SQLite uses `?`, PostgreSQL uses `$1, $2, ...`
 *  2. Booleans   — SQLite drivers can only bind number/string/bigint/buffer/null,
 *                  so JS booleans must become 0/1.
 *  3. Timestamps — "now" has to be produced by each engine in the exact same
 *                  ISO-8601 UTC shape, otherwise string comparison on timestamp
 *                  columns silently breaks across the two formats.
 */

/**
 * ISO-8601 UTC template, matching what `Date.prototype.toISOString()` emits:
 * `2026-01-02T03:04:05.678Z`.
 *
 * The literal `T` and `Z` must be double-quoted inside a `to_char` format
 * string. A Postgres single-quoted literal cannot contain single quotes, so
 * writing `'YYYY-MM-DD'T'HH24:MI:SS.MS'Z'` terminates the literal early and
 * produces a syntax error at runtime.
 */
export const ISO_UTC_MILLIS = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/** ISO-8601 UTC calendar date — the canonical shape for `daily_status.date`. */
export const ISO_UTC_DATE = 'YYYY-MM-DD';

/**
 * A `now()` expression that both engines accept in a DEFAULT clause and that
 * emits byte-identical text.
 *
 * Parentheses matter: SQLite only accepts a literal or a fully parenthesised
 * expression after `DEFAULT`, so a bare `strftime(...)` is a syntax error.
 */
export function nowExpression(dialect: Dialect): string {
  return dialect === 'sqlite'
    ? `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    : `(to_char(now() at time zone 'UTC', '${ISO_UTC_MILLIS}'))`;
}

/** A `today()` expression that both engines accept, as `YYYY-MM-DD`. */
export function nowDateExpression(dialect: Dialect): string {
  return dialect === 'sqlite'
    ? `(strftime('%Y-%m-%d', 'now'))`
    : `(to_char(now() at time zone 'UTC', '${ISO_UTC_DATE}'))`;
}

/** Replace `{{now}}` / `{{now_date}}` tokens with the engine's own expression. */
export function expandTokens(sql: string, dialect: Dialect): string {
  return sql
    .replace(/\{\{\s*now_date\s*\}\}/g, nowDateExpression(dialect))
    .replace(/\{\{\s*now\s*\}\}/g, nowExpression(dialect));
}

/**
 * Rewrite `?` placeholders into `$1, $2, ...` for PostgreSQL.
 *
 * This is a scanner rather than a regex because a naive `sql.replace(/\?/g, ...)`
 * corrupts any query containing a `?` inside a string literal, a quoted
 * identifier, or a comment — e.g. a monitor URL with a query string.
 */
export function rewritePlaceholders(sql: string, dialect: Dialect): string {
  if (dialect === 'sqlite') return sql;

  let out = '';
  let index = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    // Single-quoted string literal ('' escapes a quote)
    if (ch === "'") {
      const end = findStringEnd(sql, i, "'");
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      const end = findStringEnd(sql, i, '"');
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '?') {
      index += 1;
      out += `$${index}`;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Returns the index just past the closing quote starting at `start`. */
function findStringEnd(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      // Doubled quote is an escaped quote, not a terminator.
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
 * Make a parameter value bindable by the target driver.
 *
 * SQLite drivers reject JS booleans, `undefined`, and `Date` outright. We
 * normalise all three here so callers can pass natural values.
 */
export function coerceParam(value: unknown, dialect: Dialect): unknown {
  if (value === undefined || value === null) return null;

  if (typeof value === 'boolean') {
    return dialect === 'sqlite' ? (value ? 1 : 0) : value;
  }

  if (value instanceof Date) return value.toISOString();

  // BigInt is not bindable by the SQLite drivers either.
  if (typeof value === 'bigint') return dialect === 'sqlite' ? Number(value) : value.toString();

  return value;
}

export function coerceParams(
  params: readonly unknown[] | undefined,
  dialect: Dialect,
): unknown[] {
  if (!params) return [];
  return params.map((p) => coerceParam(p, dialect));
}

/** Expand tokens, rewrite placeholders and coerce params — the full pipeline. */
export function prepare(
  sql: string,
  params: readonly unknown[] | undefined,
  dialect: Dialect,
): { sql: string; params: unknown[] } {
  const expanded = expandTokens(sql, dialect);
  return {
    sql: rewritePlaceholders(expanded, dialect),
    params: coerceParams(params, dialect),
  };
}

/** Current time as the canonical ISO-8601 UTC string, for values the app writes. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Current UTC date as `YYYY-MM-DD`, matching `ISO_UTC_DATE`. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
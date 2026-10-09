import { nowIso } from '../db/dialect.ts';
import type { DatabaseAdapter } from '../db/types.ts';
import type {
  Check,
  DailyStatus,
  Monitor,
  MonitorStatus,
  MonitorWithStatus,
} from '../../shared/types.ts';

/**
 * Monitor persistence.
 *
 * The dashboard needs, for every monitor: the monitor row, its most recent
 * check, and its uptime windows. Doing that per-monitor would be an N+1 storm
 * — at 25 monitors that is 75 queries on a free-tier database.
 *
 * Instead this module issues a fixed **three queries** regardless of monitor
 * count and joins the results in TypeScript:
 *   1. all monitors
 *   2. latest check per monitor (single grouped join)
 *   3. uptime rollups for the requested windows
 */

// SQLite and PostgreSQL disagree on column naming for the adapter's boolean
// columns, so rows are normalised through these helpers.
import { toBool, toNum, toNumOrZero } from '../auth/session.ts';

export interface MonitorRow {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  method: string;
  headers: string | null;
  body: string | null;
  script: string | null;
  group_id: string | null;
  interval_seconds: number;
  timeout_ms: number;
  retries: number;
  max_response_bytes: number;
  follow_redirects: unknown;
  expected_status_min: number | null;
  expected_status_max: number | null;
  latency_warn_ms: number | null;
  latency_fail_ms: number | null;
  active: unknown;
  created_at: string;
  updated_at: string;
}

function mapMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'dsl' ? 'dsl' : 'http',
    url: row.url,
    method: row.method,
    headers: row.headers,
    body: row.body,
    script: row.script,
    group_id: row.group_id,
    interval_seconds: toNumOrZero(row.interval_seconds),
    timeout_ms: toNumOrZero(row.timeout_ms),
    retries: toNumOrZero(row.retries),
    max_response_bytes: toNumOrZero(row.max_response_bytes),
    follow_redirects: toBool(row.follow_redirects),
    expected_status_min: toNum(row.expected_status_min),
    expected_status_max: toNum(row.expected_status_max),
    latency_warn_ms: toNum(row.latency_warn_ms),
    latency_fail_ms: toNum(row.latency_fail_ms),
    active: toBool(row.active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCheck(row: Record<string, unknown>): Check {
  return {
    id: String(row.id),
    monitor_id: String(row.monitor_id),
    status: row.status as MonitorStatus,
    response_time_ms: toNum(row.response_time_ms),
    status_code: toNum(row.status_code),
    error_message: row.error_message === null ? null : String(row.error_message),
    checked_at: String(row.checked_at),
    checked_from: row.checked_from === null ? null : String(row.checked_from),
    colo: row.colo === null || row.colo === undefined ? null : String(row.colo),
    region: row.region === null || row.region === undefined ? null : String(row.region),
  };
}

export type MonitorSortKey = 'name' | 'created_at' | 'updated_at';

export const MONITOR_SORT_KEYS: readonly MonitorSortKey[] = ['name', 'created_at', 'updated_at'];

export interface ListOptions {
  groupId?: string | undefined;
  status?: MonitorStatus | undefined;
  active?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** Case-insensitive substring match against monitor name and URL. */
  search?: string | undefined;
  /** Whitelisted only — this value is interpolated into ORDER BY. */
  sort?: MonitorSortKey | undefined;
  order?: 'asc' | 'desc' | undefined;
  /**
   * Attach a per-monitor `daily` array for the 90-day bar.
   * Opt-in: at 200 monitors x 90 days this is ~18k numbers of JSON, and most
   * callers never look at it.
   */
  includeDaily?: boolean | undefined;
}

/**
 * Build the LIKE pattern for a substring search.
 *
 * `LOWER()` on both sides is what makes this behave the same on SQLite and
 * PostgreSQL: SQLite's LIKE is already case-insensitive for ASCII, Postgres's
 * is case-sensitive, and without the wrapper the same query would return
 * different rows depending on which provider is behind it.
 *
 * The wildcards are escaped so a literal `%` in the search box searches for a
 * `%` instead of matching everything.
 *
 * Truncated to 48 bytes because D1 caps any `LIKE`/`GLOB` pattern at 50, and
 * the two wrapping `%` count toward that. The request schema enforces the same
 * bound, but truncating here as well means a future caller that skips the schema
 * gets a shorter search rather than a database error. A partial pattern can
 * only return *more* rows than the full term would, never rows that do not match.
 */
function likePattern(raw: string): string {
  const escaped = raw.trim().toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`).slice(0, 48);
  return `%${escaped}%`;
}

/**
 * Interpolate the ORDER BY clause.
 *
 * `sort` reaches SQL as text, so it is matched against an allowlist rather than
 * sanitised — there is no string form of this value that is safe to pass
 * through unescaped. Unknown keys fall back to `created_at`, which is the
 * previous hardcoded behaviour.
 */
function orderByClause(sort: MonitorSortKey | undefined, order: 'asc' | 'desc' | undefined): string {
  const key = sort && MONITOR_SORT_KEYS.includes(sort) ? sort : 'created_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY m.${key} ${direction}, m.id ASC`;
}

/**
 * Fetch monitors with live status in three queries.
 * `uptimeDays` controls which rollup window is reported as `uptime_90d`.
 */
export async function listWithStatus(
  db: DatabaseAdapter,
  options: ListOptions & { uptimeDays?: number } = {},
): Promise<MonitorWithStatus[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const filters: string[] = [];
  const params: unknown[] = [];

  if (options.groupId) {
    filters.push('m.group_id = ?');
    params.push(options.groupId);
  }
  if (options.active !== undefined) {
    filters.push('m.active = ?');
    params.push(options.active);
  }
  if (options.search) {
    // A DSL monitor has no URL, so the URL half simply does not match for it.
    filters.push("(LOWER(m.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(m.url, '')) LIKE ? ESCAPE '\\')");
    const pattern = likePattern(options.search);
    params.push(pattern, pattern);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const orderBy = orderByClause(options.sort, options.order);

  const monitorsResult = await db.query<MonitorRow>(
    `SELECT * FROM monitors m ${where} ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const monitors = monitorsResult.rows.map(mapMonitor);
  if (monitors.length === 0) return [];

  const ids = monitors.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(', ');

  // Latest check per monitor. The GROUP BY + JOIN form is portable; window
  // functions would be tidier but add a version floor on SQLite.
  const latestResult = await db.query<Record<string, unknown>>(
    `SELECT c.*
       FROM checks c
       JOIN (
            SELECT monitor_id, MAX(checked_at) AS max_checked_at
              FROM checks
             WHERE monitor_id IN (${placeholders})
             GROUP BY monitor_id
           ) latest
         ON c.monitor_id = latest.monitor_id
        AND c.checked_at = latest.max_checked_at`,
    ids,
  );

  const latestByMonitor = new Map<string, Check>();
  for (const row of latestResult.rows) {
    const check = mapCheck(row);
    // Two checks can share a timestamp at second granularity; keep one.
    if (!latestByMonitor.has(check.monitor_id)) latestByMonitor.set(check.monitor_id, check);
  }

  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const sinceWindow = new Date(
    Date.now() - (options.uptimeDays ?? 90) * 86_400_000,
  ).toISOString();

  const shortWindowResult = await db.query<{ monitor_id: string; total: number; up: number }>(
    `SELECT monitor_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
       FROM checks
      WHERE monitor_id IN (${placeholders}) AND checked_at >= ? AND status <> 'degraded'
      GROUP BY monitor_id`,
    [...ids, since24h],
  );

  const longWindowResult = await db.query<{ monitor_id: string; total: number; up: number }>(
    `SELECT monitor_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
       FROM checks
      WHERE monitor_id IN (${placeholders}) AND checked_at >= ? AND status <> 'degraded'
      GROUP BY monitor_id`,
    [...ids, sinceWindow],
  );

  // 24h from raw checks; the long window from the daily rollup table, which is
  // what keeps 90-day views at ~90 rows per monitor instead of ~130k.
  const rollupResult = await db.query<{
    monitor_id: string;
    total: number;
    up: number;
    avg_rt: number | null;
  }>(
    `SELECT monitor_id,
            SUM(total_checks) AS total,
            SUM(up_checks) AS up,
            SUM(CASE WHEN total_checks > 0 THEN avg_response_time_ms * total_checks ELSE 0 END)
              / NULLIF(SUM(total_checks), 0) AS avg_rt
       FROM daily_status
      WHERE monitor_id IN (${placeholders}) AND date >= ?
      GROUP BY monitor_id`,
    [...ids, sinceWindow.slice(0, 10)],
  );

  const uptime = (row: { total: number; up: number } | undefined): number | null => {
    const total = toNumOrZero(row?.total);
    if (total === 0) return null;
    return Math.round((toNumOrZero(row?.up) / total) * 10_000) / 100;
  };

  /**
   * Per-monitor daily uptime, loaded in one extra query and only when asked.
   *
   * The 90-day bar is the signature element of a status page, so the list view
   * wants it, but at scale it is a lot of JSON. Keeping it opt-in means the
   * cheap call stays cheap.
   */
  const dailyByMonitor = new Map<string, Array<{ date: string; uptime: number }>>();

  if (options.includeDaily && ids.length > 0) {
    const dailyRows = await db.query<{
      monitor_id: string;
      date: string;
      total: number;
      up: number;
    }>(
      `SELECT monitor_id, date, SUM(total_checks) AS total, SUM(up_checks) AS up
         FROM daily_status
        WHERE monitor_id IN (${placeholders}) AND date >= ?
        GROUP BY monitor_id, date
        ORDER BY date ASC`,
      [...ids, sinceWindow.slice(0, 10)],
    );

    for (const row of dailyRows.rows) {
      const total = toNumOrZero(row.total);
      const list = dailyByMonitor.get(String(row.monitor_id)) ?? [];
      list.push({
        date: String(row.date),
        uptime: total === 0 ? 100 : Math.round((toNumOrZero(row.up) / total) * 10_000) / 100,
      });
      dailyByMonitor.set(String(row.monitor_id), list);
    }
  }
  const avgResponse = new Map<string, number>();
  for (const row of rollupResult.rows) {
    const value = toNum(row.avg_rt);
    if (value !== null) avgResponse.set(String(row.monitor_id), Math.round(value));
  }

  const shortById = new Map(shortWindowResult.rows.map((r) => [String(r.monitor_id), r]));
  const longById = new Map(longWindowResult.rows.map((r) => [String(r.monitor_id), r]));
  const rollupById = new Map(rollupResult.rows.map((r) => [String(r.monitor_id), r]));

  let result: MonitorWithStatus[] = monitors.map((monitor) => {
    const lastCheck = latestByMonitor.get(monitor.id) ?? null;
    return {
      ...monitor,
      current_status: lastCheck?.status ?? null,
      last_check: lastCheck,
      uptime_24h: uptime(shortById.get(monitor.id)),
      uptime_90d: uptime(longById.get(monitor.id) ?? rollupById.get(monitor.id)),
      avg_response_time_ms: avgResponse.get(monitor.id) ?? null,
      ...(options.includeDaily ? { daily: dailyByMonitor.get(monitor.id) ?? [] } : {}),
    };
  });

  if (options.status) {
    const wanted = options.status;
    result = result.filter((monitor) => monitor.current_status === wanted);
  }

  return result;
}

export async function getById(db: DatabaseAdapter, id: string): Promise<Monitor | null> {
  const result = await db.query<MonitorRow>('SELECT * FROM monitors WHERE id = ?', [id]);
  const row = result.rows[0];
  return row ? mapMonitor(row) : null;
}

export async function exists(db: DatabaseAdapter, id: string): Promise<boolean> {
  const result = await db.query<{ n: number }>('SELECT 1 AS n FROM monitors WHERE id = ?', [id]);
  return result.rows.length > 0;
}

export async function insert(
  db: DatabaseAdapter,
  input: Record<string, unknown>,
): Promise<Monitor> {
  const id = crypto.randomUUID();
  const now = nowIso();

  await db.execute(
    `INSERT INTO monitors (
       id, name, kind, url, method, headers, body, script, group_id,
       interval_seconds, timeout_ms, retries, max_response_bytes, follow_redirects,
       expected_status_min, expected_status_max, latency_warn_ms, latency_fail_ms,
       active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.kind ?? 'http',
      input.url ?? null,
      input.method ?? 'GET',
      serializeHeaders(input.headers),
      input.body ?? null,
      input.script ?? null,
      input.group_id ?? null,
      input.interval_seconds ?? 300,
      input.timeout_ms ?? 10_000,
      input.retries ?? 0,
      input.max_response_bytes ?? 1_048_576,
      input.follow_redirects ?? true,
      input.expected_status_min ?? null,
      input.expected_status_max ?? null,
      input.latency_warn_ms ?? null,
      input.latency_fail_ms ?? null,
      input.active ?? true,
      now,
      now,
    ],
  );

  const created = await getById(db, id);
  if (!created) throw new Error('Monitor insert did not persist');
  return created;
}

/**
 * Partial update.
 *
 * Only the keys actually present in `input` are written, so a PATCH cannot
 * silently reset a field the caller did not mention. Column names come from a
 * fixed allowlist — never from user input.
 */
export async function update(
  db: DatabaseAdapter,
  id: string,
  input: Record<string, unknown>,
): Promise<Monitor | null> {
  const columns: Record<string, unknown> = {
    name: input.name,
    kind: input.kind,
    url: input.url,
    method: input.method,
    headers: 'headers' in input ? serializeHeaders(input.headers) : undefined,
    body: input.body,
    script: input.script,
    group_id: input.group_id,
    interval_seconds: input.interval_seconds,
    timeout_ms: input.timeout_ms,
    retries: input.retries,
    max_response_bytes: input.max_response_bytes,
    follow_redirects: input.follow_redirects,
    expected_status_min: input.expected_status_min,
    expected_status_max: input.expected_status_max,
    latency_warn_ms: input.latency_warn_ms,
    latency_fail_ms: input.latency_fail_ms,
    active: input.active,
  };

  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }

  if (assignments.length === 0) return getById(db, id);

  assignments.push('updated_at = ?');
  values.push(nowIso(), id);

  await db.execute(`UPDATE monitors SET ${assignments.join(', ')} WHERE id = ?`, values);
  return getById(db, id);
}

export async function remove(db: DatabaseAdapter, id: string): Promise<boolean> {
  const result = await db.execute('DELETE FROM monitors WHERE id = ?', [id]);
  return result.changes > 0;
}

/** Monitors that are due for a check, oldest first. */
export async function listActiveForSweep(
  db: DatabaseAdapter,
  limit: number,
): Promise<Monitor[]> {
  const result = await db.query<MonitorRow>(
    `SELECT * FROM monitors
      WHERE active = ?
      ORDER BY COALESCE((SELECT MAX(checked_at) FROM checks WHERE monitor_id = monitors.id), '') ASC
      LIMIT ?`,
    [true, limit],
  );
  return result.rows.map(mapMonitor);
}

export interface NewCheck {
  monitorId: string;
  status: MonitorStatus;
  responseTimeMs: number | null;
  statusCode: number | null;
  errorMessage: string | null;
  colo: string | null;
  region: string | null;
  checkedAt?: string;
}

/**
 * Write check results as one batched multi-row INSERT.
 *
 * One statement instead of N matters on D1, where every round-trip has a
 * latency floor and the free tier counts queries. Chunked to stay well under
 * SQLite's bound-variable ceiling (999 on older builds).
 */
export async function insertChecks(
  db: DatabaseAdapter,
  checks: readonly NewCheck[],
): Promise<number> {
  if (checks.length === 0) return 0;

  const COLUMNS = 9;
  // 900 / 9 leaves generous headroom below the 999-variable limit.
  const CHUNK = 100;

  for (let offset = 0; offset < checks.length; offset += CHUNK) {
    const slice = checks.slice(offset, offset + CHUNK);
    const group = `(${new Array(COLUMNS).fill('?').join(', ')})`;

    const params: unknown[] = [];
    for (const check of slice) {
      params.push(
        crypto.randomUUID(),
        check.monitorId,
        check.status,
        check.responseTimeMs,
        check.statusCode,
        check.errorMessage ? check.errorMessage.slice(0, 2000) : null,
        check.colo,
        check.region,
        check.checkedAt ?? nowIso(),
      );
    }

    await db.execute(
      `INSERT INTO checks (id, monitor_id, status, response_time_ms, status_code, error_message, colo, region, checked_at)
       VALUES ${slice.map(() => group).join(', ')}`,
      params,
    );
  }

  return checks.length;
}

export async function recentChecks(
  db: DatabaseAdapter,
  monitorId: string,
  limit: number,
): Promise<Check[]> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?',
    [monitorId, Math.min(Math.max(limit, 1), 2000)],
  );
  return result.rows.map(mapCheck);
}

export async function dailyStatus(
  db: DatabaseAdapter,
  monitorId: string,
  days: number,
): Promise<DailyStatus[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM daily_status WHERE monitor_id = ? AND date >= ? ORDER BY date ASC`,
    [monitorId, since],
  );

  return result.rows.map((row) => ({
    monitor_id: String(row.monitor_id),
    date: String(row.date),
    total_checks: toNumOrZero(row.total_checks),
    up_checks: toNumOrZero(row.up_checks),
    down_checks: toNumOrZero(row.down_checks),
    degraded_checks: toNumOrZero(row.degraded_checks),
    downtime_seconds: toNumOrZero(row.downtime_seconds),
    avg_response_time_ms: toNum(row.avg_response_time_ms),
    max_response_time_ms: toNum(row.max_response_time_ms),
    p95_response_time_ms: toNum(row.p95_response_time_ms),
  }));
}

/** Per-colo rollup powering the edge map. */
export async function edgeNodeStats(
  db: DatabaseAdapter,
  hours = 24,
): Promise<Map<string, { checks: number; failures: number; totalMs: number; last: string | null }>> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const result = await db.query<{ colo: string; checks: number; failures: number; total_ms: number; last: string | null }>(
    `SELECT colo,
            COUNT(*) AS checks,
            SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS failures,
            SUM(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms ELSE 0 END) AS total_ms,
            MAX(checked_at) AS last
       FROM checks
      WHERE colo IS NOT NULL AND checked_at >= ?
      GROUP BY colo`,
    [since],
  );

  const map = new Map<string, { checks: number; failures: number; totalMs: number; last: string | null }>();
  for (const row of result.rows) {
    map.set(String(row.colo), {
      checks: toNumOrZero(row.checks),
      failures: toNumOrZero(row.failures),
      totalMs: toNumOrZero(row.total_ms),
      last: row.last === null ? null : String(row.last),
    });
  }
  return map;
}

/** Monitors that reference a group — used before deleting one. */
export async function countByGroup(db: DatabaseAdapter, groupId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM monitors WHERE group_id = ?',
    [groupId],
  );
  return toNumOrZero(result.rows[0]?.n);
}

function serializeHeaders(headers: unknown): string | null {
  if (headers === null || headers === undefined) return null;
  if (typeof headers === 'string') return headers;
  return JSON.stringify(headers);
}
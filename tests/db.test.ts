import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';
import { getDb, ensureMigrated, ConfigError } from '../src/worker/db/index.ts';
import { prepare, expandTokens, rewritePlaceholders, coerceParams } from '../src/worker/db/dialect.ts';
import { splitStatements } from '../src/worker/db/base.ts';

let dir: string;
let dbPath: string;
let db: LibsqlAdapter;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-test-'));
  dbPath = join(dir, 'test.db');
  db = await LibsqlAdapter.create('sqlite', { url: `file:${dbPath}` });
  await db.connect();
});

after(async () => {
  await db.close();
  // Windows keeps a handle on the SQLite file briefly, so a synchronous rm
  // races the driver. Retry a few times rather than failing the run.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

describe('dialect translation', () => {
  test('rewrites placeholders only for postgres', () => {
    assert.equal(rewritePlaceholders('SELECT * FROM t WHERE a = ?', 'sqlite'), 'SELECT * FROM t WHERE a = ?');
    assert.equal(rewritePlaceholders('SELECT * FROM t WHERE a = ?', 'postgres'), 'SELECT * FROM t WHERE a = $1');
    assert.equal(
      rewritePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?', 'postgres'),
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  test('ignores question marks inside string literals', () => {
    const sql = "SELECT * FROM t WHERE label = 'what? really?' AND a = ?";
    assert.equal(
      rewritePlaceholders(sql, 'postgres'),
      "SELECT * FROM t WHERE label = 'what? really?' AND a = $1",
    );
  });

  test('ignores question marks inside comments and quoted identifiers', () => {
    const sql = '-- is it? yes\nSELECT "we?ird" FROM t /* also? */ WHERE a = ?';
    assert.equal(
      rewritePlaceholders(sql, 'postgres'),
      '-- is it? yes\nSELECT "we?ird" FROM t /* also? */ WHERE a = $1',
    );
  });

  test('handles escaped quotes in literals', () => {
    const sql = "SELECT * FROM t WHERE a = 'it''s ok?' AND b = ?";
    assert.equal(
      rewritePlaceholders(sql, 'postgres'),
      "SELECT * FROM t WHERE a = 'it''s ok?' AND b = $1",
    );
  });

  test('coerces booleans to 0/1 for sqlite only', () => {
    assert.deepEqual(coerceParams([true, false], 'sqlite'), [1, 0]);
    assert.deepEqual(coerceParams([true, false], 'postgres'), [true, false]);
  });

  test('normalises undefined and Date to bindable values', () => {
    const params = coerceParams([undefined, new Date('2026-01-02T03:04:05.678Z')], 'sqlite');
    assert.equal(params[0], null);
    assert.equal(params[1], '2026-01-02T03:04:05.678Z');
  });

  test('expands now tokens per dialect', () => {
    const sqlite = expandTokens('DEFAULT {{now}}', 'sqlite');
    const postgres = expandTokens('DEFAULT {{now}}', 'postgres');
    assert.ok(sqlite.includes("strftime('%Y-%m-%dT%H:%M:%fZ'"));
    assert.ok(postgres.includes('to_char'));
    assert.ok(expandTokens('{{now_date}}', 'sqlite').includes("strftime('%Y-%m-%d'"));
  });

  test('prepare() runs the whole pipeline', () => {
    const out = prepare('SELECT * FROM t WHERE a = ? AND b = ?', [true, 'x'], 'postgres');
    assert.equal(out.sql, 'SELECT * FROM t WHERE a = $1 AND b = $2');
    assert.deepEqual(out.params, [true, 'x']);
  });
});

describe('statement splitting', () => {
  test('splits on top-level semicolons only', () => {
    const sql = `
      -- a comment with ; inside
      CREATE TABLE a (x TEXT DEFAULT 'semi;colon');
      CREATE INDEX i ON a (x);
    `;
    const parts = splitStatements(sql);
    assert.equal(parts.length, 2);
    assert.ok(parts[0]!.includes('CREATE TABLE a'));
    assert.ok(parts[1]!.includes('CREATE INDEX i'));
  });
});

describe('libsql adapter + auto-migration', () => {
  test('migrate() creates every table in the bundled schema', async () => {
    const result = await db.migrate();
    assert.ok(result.applied.includes('0001_init'), '0001_init should be applied');

    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.rows.map((r) => r.name);

    for (const expected of [
      'alert_states',
      'app_settings',
      'audit_log',
      'checks',
      'daily_status',
      'incident_updates',
      'incidents',
      'monitor_groups',
      'monitor_notifications',
      'monitors',
      'notification_channels',
      'schema_migrations',
      'sessions',
      'users',
    ]) {
      assert.ok(names.includes(expected), `expected table ${expected}, got: ${names.join(', ')}`);
    }
  });

  test('migrate() is idempotent across adapter instances', async () => {
    // A fresh adapter re-reads schema_migrations and must apply nothing. The
    // per-isolate result cache is bypassed on purpose, since that is what a
    // new cold start looks like in production.
    const second = await LibsqlAdapter.create('sqlite', { url: `file:${dbPath}` });
    await second.connect();
    const result = await second.migrate();
    assert.deepEqual(result.applied, [], 'nothing should be re-applied');
    assert.ok(result.skipped.includes('0001_init'));
    await second.close();
  });

  test('migrate() coalesces concurrent calls into one run', async () => {
    const concurrent = await LibsqlAdapter.create('sqlite', { url: `file:${dbPath}` });
    await concurrent.connect();
    const [a, b, c] = await Promise.all([
      concurrent.migrate(),
      concurrent.migrate(),
      concurrent.migrate(),
    ]);
    assert.equal(a, b);
    assert.equal(b, c);
    await concurrent.close();
  });

  test('schema CHECK constraints reject bad monitor rows', async () => {
    // kind = 'http' without a url can never be executed by the check engine.
    await assert.rejects(
      () =>
        db.execute(
          `INSERT INTO monitors (id, name, kind, active) VALUES (?, ?, ?, ?)`,
          [crypto.randomUUID(), 'No URL', 'http', true],
        ),
      /CHECK constraint/i,
    );

    await assert.rejects(
      () =>
        db.execute(
          `INSERT INTO monitors (id, name, kind, active) VALUES (?, ?, ?, ?)`,
          [crypto.randomUUID(), 'Bad kind', 'telepathy', true],
        ),
      /CHECK constraint/i,
    );

    await assert.rejects(
      () =>
        db.execute(
          `INSERT INTO users (id, name, email, password_hash, role)
           VALUES (?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), 'X', 'x@example.com', 'hash', 'superuser'],
        ),
      /CHECK constraint/i,
    );
  });

  test('insert/select round-trip with booleans and JSON columns', async () => {
    const id = crypto.randomUUID();
    const groupId = crypto.randomUUID();

    await db.execute(
      `INSERT INTO monitor_groups (id, name, slug, is_public, display_order)
       VALUES (?, ?, ?, ?, ?)`,
      [groupId, 'API', 'api', true, 1],
    );

    await db.execute(
      `INSERT INTO monitors (id, name, kind, url, method, group_id, active, interval_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'Example', 'http', 'https://example.com', 'GET', groupId, false, 300],
    );

    const row = await db.query<{ active: unknown; name: string; kind: string }>(
      'SELECT active, name, kind FROM monitors WHERE id = ?',
      [id],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0]!.name, 'Example');
    assert.equal(row.rows[0]!.kind, 'http');
    // SQLite BOOLEAN comes back as 0/1 through our coercion.
    assert.equal(row.rows[0]!.active, 0);

    await db.execute('DELETE FROM monitors WHERE id = ?', [id]);
    await db.execute('DELETE FROM monitor_groups WHERE id = ?', [groupId]);
  });

  test('ON CONFLICT DO UPDATE works (upsert on both engines)', async () => {
    const monitorId = crypto.randomUUID();
    const date = '2026-01-01';

    const upsert = async (upChecks: number) =>
      db.execute(
        `INSERT INTO daily_status (monitor_id, date, total_checks, up_checks)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (monitor_id, date) DO UPDATE SET up_checks = excluded.up_checks`,
        [monitorId, date, 10, upChecks],
      );

    await db.execute(
      `INSERT INTO monitors (id, name, kind, url, active) VALUES (?, ?, ?, ?, ?)`,
      [monitorId, 'Upsert', 'http', 'https://example.com', true],
    );

    await upsert(5);
    await upsert(9);

    const rows = await db.query<{ up_checks: number; total_checks: number }>(
      'SELECT up_checks, total_checks FROM daily_status WHERE monitor_id = ? AND date = ?',
      [monitorId, date],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.up_checks, 9);
    assert.equal(rows.rows[0]!.total_checks, 10);

    await db.execute('DELETE FROM monitors WHERE id = ?', [monitorId]);
  });

  test('aggregates return numbers, not strings', async () => {
    const monitorId = crypto.randomUUID();
    await db.execute(
      `INSERT INTO monitors (id, name, kind, url, active) VALUES (?, ?, ?, ?, ?)`,
      [monitorId, 'Agg', 'http', 'https://example.com', true],
    );

    const statements = Array.from({ length: 7 }, (_, i) => ({
      sql: `INSERT INTO checks (id, monitor_id, status, response_time_ms, checked_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [
        crypto.randomUUID(),
        monitorId,
        i < 6 ? 'up' : 'down',
        100 + i,
        `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
      ],
    }));

    const metas = await db.batch(statements);
    assert.equal(metas.length, 7);
    assert.ok(metas[0]!.changes === 1, 'batch reports 1 change per row');

    const agg = await db.query<{ total: number; up: number }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
         FROM checks WHERE monitor_id = ?`,
      [monitorId],
    );
    assert.equal(agg.rows[0]!.total, 7);
    assert.equal(agg.rows[0]!.up, 6);

    await db.execute('DELETE FROM monitors WHERE id = ?', [monitorId]);
  });

  test('batch() is atomic and rolls back on failure', async () => {
    const goodId = crypto.randomUUID();
    await assert.rejects(
      () =>
        db.batch([
          {
            sql: `INSERT INTO monitors (id, name, kind, url, active) VALUES (?, ?, ?, ?, ?)`,
            params: [goodId, 'Atomic', 'http', 'https://example.com', true],
          },
          // violates the CHECK on `kind`
          {
            sql: `INSERT INTO monitors (id, name, kind, url, active) VALUES (?, ?, ?, ?, ?)`,
            params: [crypto.randomUUID(), 'Bad', 'nonsense', 'https://example.com', true],
          },
        ]),
      /constraint/i,
    );

    const rows = await db.query('SELECT id FROM monitors WHERE id = ?', [goodId]);
    assert.equal(rows.rows.length, 0, 'first insert must have rolled back');
  });

  test('transaction() commits on success', async () => {
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO monitors (id, name, kind, url, active) VALUES (?, ?, ?, ?, ?)`,
        [id, 'Tx', 'http', 'https://example.com', true],
      );
    });
    const rows = await db.query('SELECT id FROM monitors WHERE id = ?', [id]);
    assert.equal(rows.rows.length, 1);
    await db.execute('DELETE FROM monitors WHERE id = ?', [id]);
  });

  test('foreign keys cascade on delete', async () => {
    const monitorId = crypto.randomUUID();
    await db.execute(
      `INSERT INTO monitors (id, name, kind, url, active) VALUES (?, ?, ?, ?, ?)`,
      [monitorId, 'Cascade', 'http', 'https://example.com', true],
    );
    await db.execute(
      `INSERT INTO checks (id, monitor_id, status, checked_at)
       VALUES (?, ?, 'up', '2026-01-01T00:00:00.000Z')`,
      [crypto.randomUUID(), monitorId],
    );

    await db.execute('DELETE FROM monitors WHERE id = ?', [monitorId]);

    const checks = await db.query('SELECT id FROM checks WHERE monitor_id = ?', [monitorId]);
    assert.equal(checks.rows.length, 0, 'checks should cascade-delete');
  });

  test('healthCheck() reports ok', async () => {
    const report = await db.healthCheck();
    assert.equal(report.ok, true);
    assert.equal(report.provider, 'sqlite');
    assert.equal(report.dialect, 'sqlite');
  });
});

describe('provider selection', () => {
  test('getDb() resolves the sqlite provider from env', async () => {
    const adapter = await getDb({
      DB_PROVIDER: 'sqlite',
      DATABASE_URL: `file:${dbPath}`,
    });
    assert.equal(adapter.provider, 'sqlite');
    await ensureMigrated(adapter);
  });

  test('defaults to d1 when DB_PROVIDER is unset', async () => {
    await assert.rejects(
      () => getDb({}),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /DB_PROVIDER=d1/);
        return true;
      },
    );
  });

  test('reports missing credentials clearly for turso', async () => {
    await assert.rejects(
      () => getDb({ DB_PROVIDER: 'turso' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TURSO_DATABASE_URL/);
        return true;
      },
    );
  });

  test('rejects an IPv6-only Supabase direct connection', async () => {
    await assert.rejects(
      () => getDb({ DB_PROVIDER: 'supabase', SUPABASE_DATABASE_URL: 'postgresql://postgres.x:pw@db.abc.supabase.co:5432/postgres' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /pooler/);
        return true;
      },
    );
  });
});
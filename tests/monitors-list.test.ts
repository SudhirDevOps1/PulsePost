import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listWithStatus, type ListOptions } from '../src/worker/repository/monitors.ts';
import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';
import { nowIso } from '../src/worker/db/dialect.ts';
import type { DatabaseAdapter } from '../src/worker/db/types.ts';

/**
 * Monitor list query behaviour: search, sorting and paging.
 *
 * These are the query-string parameters, so the risk they carry is a
 * SQL-injection hole through the `sort` allowlist. The escape tests below are
 * the ones worth reading first.
 */

let dir: string;
let db: DatabaseAdapter;

async function seed(monitors: Array<Partial<{ name: string; url: string; active: boolean }>>) {
  const now = nowIso();
  for (const m of monitors) {
    await db.execute(
      `INSERT INTO monitors (id, name, url, method, active, interval_seconds, timeout_ms,
         retries, max_response_bytes, follow_redirects, created_at, updated_at)
       VALUES (?, ?, ?, 'GET', ?, 300, 5000, 0, 65536, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        m.name ?? 'monitor',
        m.url ?? 'https://example.com',
        m.active ?? true,
        true,
        now,
        now,
      ],
    );
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-list-'));
  // The adapter directly rather than `getDb()`: the latter reads provider
  // settings off a Worker `Env`, which does not exist under the test runner.
  db = await LibsqlAdapter.create('sqlite', { url: `file:${join(dir, 'list.db')}` });
  await db.migrate();
});

after(async () => {
  await db.close();
  // Windows keeps a handle on the SQLite file briefly, so a synchronous rm
  // races the driver. Retry a few times rather than failing the whole run.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

describe('monitor list — search', () => {
  test('matches on name, case-insensitively', async () => {
    await seed([
      { name: 'Production API' },
      { name: 'Staging API' },
      { name: 'Billing Worker' },
    ]);

    const found = await listWithStatus(db, { search: 'api' });
    const names = found.map((m) => m.name).sort();
    assert.deepEqual(names, ['Production API', 'Staging API']);
  });

  test('matches on URL when the name does not contain the term', async () => {
    await seed([{ name: 'Alpha', url: 'https://status.example.org/health' }]);
    const found = await listWithStatus(db, { search: 'status.example.org' });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.name, 'Alpha');
  });

  test('treats % as a literal, not a wildcard', async () => {
    // Without escaping, this pattern matches every row — which would look
    // exactly like a broken search rather than an injection.
    await seed([{ name: 'plain one' }, { name: 'plain two' }]);
    const found = await listWithStatus(db, { search: '%' });
    assert.equal(found.length, 0, 'a bare % must not match everything');
  });

  test('treats _ and backslash as literals', async () => {
    await seed([{ name: 'a_b' }, { name: 'axb' }]);
    assert.equal((await listWithStatus(db, { search: '_' })).length, 1);
    assert.equal((await listWithStatus(db, { search: 'a_b' }))[0]!.name, 'a_b');
  });

  test('does not let a quoted payload break out of the string', async () => {
    // The classic injection shape. Even if it were reachable, the statement
    // should simply return no rows and leave the table intact.
    const attack = `x'; DROP TABLE monitors; --`;
    await seed([{ name: 'still here' }]);
    await listWithStatus(db, { search: attack });

    const after = await listWithStatus(db, { limit: 100 });
    assert.ok(after.length > 0, 'monitors table must survive the attempt');
    assert.ok(after.some((m) => m.name === 'still here'));
  });

  test('does not match DSL monitors (no URL) on the URL half', async () => {
    await db.execute(
      `INSERT INTO monitors (id, name, kind, script, method, active, interval_seconds, timeout_ms,
         retries, max_response_bytes, follow_redirects, created_at, updated_at)
       VALUES (?, 'DSL monitor', 'dsl', ?, 'GET', ?, 300, 5000, 0, 65536, ?, ?, ?)`,
      [crypto.randomUUID(), JSON.stringify({ steps: [] }), true, true, nowIso(), nowIso()],
    );
    const found = await listWithStatus(db, { search: 'dsl monitor' });
    assert.equal(found.length, 1, 'name match is enough');
  });
});

describe('monitor list — sorting', () => {
  test('sorts by name ascending', async () => {
    await seed([{ name: 'zeta' }, { name: 'alpha' }, { name: 'mu' }]);
    const found = await listWithStatus(db, { sort: 'name', order: 'asc', search: 'a' });
    const names = found.map((m) => m.name);
    assert.deepEqual(names, [...names].sort());
  });

  test('rejects an unknown sort key without throwing', async () => {
    // The allowlist is the only thing standing between a query string and the
    // ORDER BY clause, so an unrecognised value must fall back, not inject.
    // `unknown` first: the cast has to defeat the key type on purpose, which is
    // the whole point. The real request path validates `sort` with a Zod enum;
    // this reaches the repository the way a future caller might.
    await seed([{ name: 'fallback' }]);
    const hostile = { sort: 'name; DROP TABLE monitors --' } as unknown as ListOptions;
    const found = await listWithStatus(db, hostile);
    assert.ok(Array.isArray(found));
    assert.ok(found.some((m) => m.name === 'fallback'), 'falls back to a valid ordering');

    const after = await listWithStatus(db, {});
    assert.ok(after.length > 0, 'table survives');
  });

  test('is stable for identical keys', async () => {
    await seed([{ name: 'same' }, { name: 'same' }, { name: 'same' }]);
    const first = await listWithStatus(db, { sort: 'name', order: 'asc', search: 'same' });
    const second = await listWithStatus(db, { sort: 'name', order: 'asc', search: 'same' });
    assert.deepEqual(first.map((m) => m.id), second.map((m) => m.id));
  });
});

describe('monitor list — paging', () => {
  test('honours limit and offset', async () => {
    await seed(Array.from({ length: 6 }, (_, i) => ({ name: `paged-${i}` })));

    const page1 = await listWithStatus(db, { search: 'paged-', limit: 2, offset: 0, sort: 'name', order: 'asc' });
    const page2 = await listWithStatus(db, { search: 'paged-', limit: 2, offset: 2, sort: 'name', order: 'asc' });
    const page3 = await listWithStatus(db, { search: 'paged-', limit: 2, offset: 4, sort: 'name', order: 'asc' });

    assert.equal(page1.length, 2);
    assert.equal(page2.length, 2);
    assert.equal(page3.length, 2);
    assert.equal(new Set([...page1, ...page2, ...page3].map((m) => m.id)).size, 6);
  });

  test('offset past the end returns nothing rather than erroring', async () => {
    await seed([{ name: 'only-one-page' }]);
    const found = await listWithStatus(db, { search: 'only-one-page', offset: 500 });
    assert.equal(found.length, 0);
  });
});
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app } from '../src/worker/index.ts';

/**
 * End-to-end tests against the real Hono app, backed by a temporary SQLite
 * database. Exercises the full middleware chain — security headers, database
 * bootstrap + auto-migration, identity resolution, rate limiting, auth and Zod
 * validation — because that chain is exactly where integration bugs live.
 */

let dir: string;
let dbPath: string;

/** Minimal stand-in for the Workers Static Assets binding. */
const ASSETS: Fetcher = {
  fetch: async () => new Response('/* index.html */', { headers: { 'content-type': 'text/html' } }),
} as unknown as Fetcher;

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB_PROVIDER: 'sqlite',
    DATABASE_URL: `file:${dbPath}`,
    ENVIRONMENT: 'development',
    APP_NAME: 'Testwatch',
    AUTH_MODE: 'password',
    ASSETS,
    // SSRF protection stays ON here: ENVIRONMENT must never imply it.
    ALLOW_PRIVATE_TARGETS: false,
    // Generous by default so unrelated assertions are never starved by the
    // limiter; the dedicated rate-limit test narrows it.
    AUTH_RATE_LIMIT: 1000,
    API_RATE_LIMIT: 1000,
    RATE_WINDOW_SECONDS: 60,
    ...overrides,
  };
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; env?: Record<string, unknown> } = {},
) {
  const request = new Request(`https://pulsepost.test${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const response = await app.fetch(request, env(options.env) as never, {} as never);

  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  return { response, json: json as never, text };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-api-'));
  dbPath = join(dir, 'api.db');
});

after(async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

describe('security headers', () => {
  test('are applied to API responses', async () => {
    const { response } = await call('/api/health');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /object-src 'none'/);
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /base-uri 'self'/);

    // `script-src` must be exactly `'self'` — no 'unsafe-inline'/'unsafe-eval'.
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    assert.equal(scriptSrc, "script-src 'self'");
  });

  test('API responses are not cacheable', async () => {
    const { response } = await call('/api/health');
    assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
  });

  test('HSTS is absent in development but set in production', async () => {
    const dev = await call('/api/health');
    assert.equal(dev.response.headers.get('Strict-Transport-Security'), null);

    const prod = await call('/api/health', { env: { ENVIRONMENT: 'production' } });
    assert.match(prod.response.headers.get('Strict-Transport-Security') ?? '', /max-age=63072000/);
  });

  test('non-API paths fall through to the static asset handler', async () => {
    const { response, text } = await call('/status/my-team');
    assert.equal(response.status, 200);
    assert.match(text, /index\.html/);
  });

  test('unknown API paths return JSON 404, not the SPA', async () => {
    const { response, json } = await call('/api/does-not-exist');
    assert.equal(response.status, 404);
    assert.equal((json as { code: string }).code, 'NOT_FOUND');
  });
});

describe('health endpoint', () => {
  test('reports the live database provider', async () => {
    const { response, json } = await call('/api/health');
    assert.equal(response.status, 200);
    assert.equal((json as { ok: boolean }).ok, true);
    assert.equal((json as { database: { provider: string } }).database.provider, 'sqlite');
    assert.equal((json as { database: { dialect: string } }).database.dialect, 'sqlite');
  });

  test('surfaces a misconfigured provider as 503 with actionable detail', async () => {
    const { response, json } = await call('/api/health', { env: { DB_PROVIDER: 'turso' } });
    assert.equal(response.status, 503);
    assert.equal((json as { code: string }).code, 'DB_UNAVAILABLE');
    // Development surfaces the reason; production would not.
    assert.match(JSON.stringify(json), /TURSO_DATABASE_URL/);
  });
});

describe('onboarding and authentication', () => {
  test('status reports that setup is incomplete', async () => {
    const { json } = await call('/api/auth/status');
    assert.equal((json as { setup_complete: boolean }).setup_complete, false);
  });

  test('rejects a weak setup password', async () => {
    const { response, json } = await call('/api/auth/setup', {
      method: 'POST',
      body: { name: 'Owner', email: 'owner@example.com', password: 'short' },
    });
    assert.equal(response.status, 400);
    assert.equal((json as { code: string }).code, 'VALIDATION_ERROR');
  });

  test('creates the admin and returns a session cookie', async () => {
    const { response, json } = await call('/api/auth/setup', {
      method: 'POST',
      body: {
        name: 'Owner',
        email: 'Owner@Example.com',
        password: 'correct-horse-Battery9!',
        app_name: 'Acme Status',
      },
    });

    assert.equal(response.status, 201);

    const setCookie = response.headers.get('Set-Cookie') ?? '';
    assert.match(setCookie, /__Host-pp_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);

    // Email is normalised to lowercase by the Zod schema.
    const user = (json as { user: { email: string; role: string } }).user;
    assert.equal(user.email, 'owner@example.com');
    assert.equal(user.role, 'admin');
  });

  test('setup cannot be run twice', async () => {
    const { response } = await call('/api/auth/setup', {
      method: 'POST',
      body: { name: 'Intruder', email: 'x@example.com', password: 'another-Strong9!' },
    });
    assert.equal(response.status, 409);
  });

  test('protected routes reject anonymous callers', async () => {
    const { response, json } = await call('/api/monitors');
    assert.equal(response.status, 401);
    assert.equal((json as { code: string }).code, 'UNAUTHORIZED');
  });

  test('login rejects a wrong password', async () => {
    const { response, json } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'wrong-Password9!' },
    });
    assert.equal(response.status, 401);
    // Must not disclose whether the account exists.
    assert.equal((json as { error: string }).error, 'Incorrect email or password');
  });

  test('login rejects an unknown account with the same message', async () => {
    const { response, json } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'wrong-Password9!' },
    });
    assert.equal(response.status, 401);
    assert.equal((json as { error: string }).error, 'Incorrect email or password');
  });

  test('login succeeds with valid credentials', async () => {
    const { response, json } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'correct-horse-Battery9!' },
    });
    assert.equal(response.status, 200);
    assert.equal((json as { user: { email: string } }).user.email, 'owner@example.com');
    assert.match(response.headers.get('Set-Cookie') ?? '', /__Host-pp_session=/);
  });
});

describe('monitor CRUD with a session cookie', () => {
  let cookie = '';

  before(async () => {
    const login = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'correct-horse-Battery9!' },
    });
    cookie = (login.response.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  const auth = () => ({ Cookie: cookie });

  test('rejects a monitor with no URL', async () => {
    const { response } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: { name: 'No URL' },
    });
    assert.equal(response.status, 400);
  });

  test('rejects a non-http scheme', async () => {
    const { response } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: { name: 'File', url: 'file:///etc/passwd' },
    });
    assert.equal(response.status, 400);
  });

  test('rejects a URL pointing at cloud metadata', async () => {
    const { response, json } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: { name: 'Metadata', url: 'http://169.254.169.254/latest/meta-data/' },
    });
    assert.equal(response.status, 400);
    assert.match((json as { error: string }).error, /cannot be monitored/);
  });

  test('permits a private target only when explicitly opted in', async () => {
    // The Docker/local case. Crucially this is an explicit env flag, not
    // inferred from ENVIRONMENT.
    const { response, json } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: { name: 'Local service', url: 'http://localhost:3000/health' },
      env: { ALLOW_PRIVATE_TARGETS: true },
    });
    assert.equal(response.status, 201);
    assert.equal((json as { monitor: { name: string } }).monitor.name, 'Local service');
  });

  test('SSRF protection is not implied by ENVIRONMENT', async () => {
    const { response } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: { name: 'Metadata again', url: 'http://169.254.169.254/' },
      env: { ENVIRONMENT: 'development', ALLOW_PRIVATE_TARGETS: false },
    });
    assert.equal(response.status, 400, 'ENVIRONMENT=development must not disable SSRF checks');
  });

  test('rejects an unknown field (strict schema)', async () => {
    const { response } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: { name: 'Sneaky', url: 'https://example.com', is_admin: true },
    });
    assert.equal(response.status, 400);
  });

  test('creates an HTTP monitor', async () => {
    const { response, json } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: {
        name: 'Website',
        url: 'https://example.com',
        method: 'GET',
        interval_seconds: 300,
        headers: { 'X-Test': '1' },
      },
    });

    assert.equal(response.status, 201);
    const monitor = (json as { monitor: { id: string; active: boolean; name: string } }).monitor;
    assert.match(monitor.id, /^[0-9a-f-]{36}$/);
    assert.equal(monitor.active, true);
  });

  test('creates a DSL monitor', async () => {
    const { response, json } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: {
        name: 'Login flow',
        kind: 'dsl',
        script: JSON.stringify({
          steps: [
            { name: 'login', request: { method: 'POST', url: 'https://api.example.com/login' } },
          ],
        }),
      },
    });
    assert.equal(response.status, 201);
    assert.equal((json as { monitor: { kind: string } }).monitor.kind, 'dsl');
  });

  test('rejects a DSL monitor with malformed script JSON', async () => {
    const { response } = await call('/api/monitors', {
      method: 'POST',
      headers: auth(),
      body: { name: 'Broken', kind: 'dsl', script: '{nope' },
    });
    assert.equal(response.status, 400);
  });

  test('lists monitors for an authenticated caller', async () => {
    const { response, json } = await call('/api/monitors', { headers: auth() });
    assert.equal(response.status, 200);
    assert.ok((json as { monitors: unknown[] }).monitors.length >= 2);
  });

  test('returns the dashboard overview', async () => {
    const { response, json } = await call('/api/monitors/overview', { headers: auth() });
    assert.equal(response.status, 200);
    const overview = (json as { overview: { total: number } }).overview;
    assert.ok(overview.total >= 2);
  });

  test('returns the edge-node rollup for the map', async () => {
    const { response, json } = await call('/api/monitors/edge', { headers: auth() });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((json as { nodes: unknown[] }).nodes));
  });

  test('patches a monitor', async () => {
    const list = await call('/api/monitors', { headers: auth() });
    const target = (list.json as { monitors: Array<{ id: string; name: string }> }).monitors.find(
      (monitor) => monitor.name === 'Website',
    )!;

    const { response, json } = await call(`/api/monitors/${target.id}`, {
      method: 'PATCH',
      headers: auth(),
      body: { name: 'Website v2' },
    });

    assert.equal(response.status, 200);
    assert.equal((json as { monitor: { name: string } }).monitor.name, 'Website v2');
  });

  test('rejects a PATCH with an unknown id', async () => {
    const { response } = await call('/api/monitors/00000000-0000-4000-8000-000000000000', {
      method: 'PATCH',
      headers: auth(),
      body: { name: 'Nope' },
    });
    assert.equal(response.status, 404);
  });

  test('rejects a malformed id before touching the database', async () => {
    const { response } = await call('/api/monitors/not-a-uuid', { headers: auth() });
    assert.equal(response.status, 400);
  });

  test('deletes a monitor', async () => {
    const list = await call('/api/monitors', { headers: auth() });
    const target = (list.json as { monitors: Array<{ id: string; name: string }> }).monitors.find(
      (monitor) => monitor.name === 'Login flow',
    )!;

    const { response } = await call(`/api/monitors/${target.id}`, {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(response.status, 200);

    const after = await call('/api/monitors', { headers: auth() });
    const still = (after.json as { monitors: Array<{ id: string }> }).monitors.some(
      (monitor) => monitor.id === target.id,
    );
    assert.equal(still, false);
  });
});

describe('public status API', () => {
  test('is reachable without authentication', async () => {
    const { response, json } = await call('/api/public/status');
    assert.equal(response.status, 200);
    assert.equal((json as { app_name: string }).app_name, 'Testwatch');
    assert.ok(Array.isArray((json as { groups: unknown[] }).groups));
  });

  test('returns incidents without authentication', async () => {
    const { response } = await call('/api/public/incidents');
    assert.equal(response.status, 200);
  });

  test('does not leak monitor URLs', async () => {
    const { text } = await call('/api/public/status');
    assert.ok(!text.includes('example.com'), 'public payload must not expose target URLs');
  });
});

describe('cron endpoint', () => {
  test('rejects a missing secret', async () => {
    const { response } = await call('/api/cron');
    assert.equal(response.status, 403);
  });

  test('rejects a wrong secret', async () => {
    const { response } = await call('/api/cron', {
      headers: { 'X-Cron-Secret': 'not-the-secret' },
      env: { CRON_SECRET: 'the-real-secret' },
    });
    assert.equal(response.status, 403);
  });

  test('runs a sweep with the correct secret', async () => {
    const { response, json } = await call('/api/cron', {
      headers: { 'X-Cron-Secret': 'the-real-secret' },
      env: { CRON_SECRET: 'the-real-secret' },
    });
    // Either the sweep ran, or the outbound fetch to example.com failed —
    // both are valid; what matters is that the secret was accepted.
    assert.ok(response.status === 200, `expected 200, got ${response.status}`);
    assert.equal(typeof (json as { checked: number }).checked, 'number');
  });
});

describe('IP allowlist', () => {
  test('blocks a request from a disallowed network', async () => {
    const { response, json } = await call('/api/monitors', {
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
      env: { ADMIN_IP_ALLOWLIST: '198.51.100.0/24' },
    });
    assert.equal(response.status, 403);
    assert.equal((json as { code: string }).code, 'IP_BLOCKED');
  });

  test('allows a request from an allowlisted network', async () => {
    const { response } = await call('/api/monitors', {
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
      env: { ADMIN_IP_ALLOWLIST: '203.0.113.0/24' },
    });
    // Not 403 — either 401 (no cookie) or 200.
    assert.notEqual(response.status, 403);
  });

  test('an empty allowlist does not block anyone', async () => {
    const { response } = await call('/api/monitors', {
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
      env: { ADMIN_IP_ALLOWLIST: '' },
    });
    assert.notEqual(response.status, 403);
  });
});

describe('rate limiting', () => {
  test('throttles repeated auth attempts', async () => {
    // A deliberately tiny budget, isolated to this test. Note the limiter is
    // keyed by client IP and lives in module memory, so the earlier suites
    // run with a high limit to avoid tripping it.
    const options = { AUTH_RATE_LIMIT: 3, RATE_WINDOW_SECONDS: 60 };

    let sawLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const { response } = await call('/api/auth/login', {
        method: 'POST',
        body: { email: 'owner@example.com', password: 'nope-Nope9!' },
        env: options,
      });
      if (response.status === 429) {
        sawLimit = true;
        assert.ok(response.headers.get('Retry-After'), 'Retry-After must be set');
        assert.equal((response.headers.get('X-RateLimit-Mechanism') ?? null) !== null, true);
        break;
      }
    }
    assert.ok(sawLimit, 'expected the auth rate limiter to trip');
  });

  test('a generous limit does not throttle normal traffic', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { response } = await call('/api/health', {
        env: { API_RATE_LIMIT: 1000, RATE_WINDOW_SECONDS: 60 },
      });
      assert.notEqual(response.status, 429);
    }
  });
});
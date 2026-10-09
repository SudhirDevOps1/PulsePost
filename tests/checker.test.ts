import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { classifyHost, validateUrl, assertAllowed, SsrfError, DEFAULT_POLICY } from '../src/worker/checkers/ssrf.ts';
import { runCheck, evaluateAssertion } from '../src/worker/checkers/engine.ts';
import type { Monitor } from '../src/shared/types.ts';

/** Minimal monitor fixture; only the fields the engine reads. */
function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 'm1',
    name: 'Test',
    kind: 'http',
    url: 'https://example.com',
    method: 'GET',
    headers: null,
    body: null,
    script: null,
    group_id: null,
    interval_seconds: 300,
    timeout_ms: 5000,
    retries: 0,
    max_response_bytes: 65_536,
    follow_redirects: true,
    expected_status_min: null,
    expected_status_max: null,
    latency_warn_ms: null,
    latency_fail_ms: null,
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SSRF host classification', () => {
  test('blocks cloud metadata and loopback', () => {
    assert.match(classifyHost('169.254.169.254') ?? '', /metadata/);
    assert.match(classifyHost('127.0.0.1') ?? '', /loopback/);
    assert.match(classifyHost('localhost') ?? '', /localhost/);
    assert.match(classifyHost('app.localhost') ?? '', /localhost/);
    assert.match(classifyHost('metadata.google.internal') ?? '', /metadata/);
    assert.match(classifyHost('instance-data.ec2.internal') ?? '', /metadata/);
  });

  test('blocks every private IPv4 range', () => {
    for (const host of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '198.18.0.1',
      '0.0.0.0',
    ]) {
      assert.ok(classifyHost(host), `${host} should be blocked`);
    }
  });

  test('allows public addresses', () => {
    assert.equal(classifyHost('1.1.1.1'), null);
    assert.equal(classifyHost('8.8.8.8'), null);
    assert.equal(classifyHost('93.184.216.34'), null);
    assert.equal(classifyHost('172.32.0.1'), null, '172.32 is outside 172.16/12');
    assert.equal(classifyHost('11.0.0.1'), null);
  });

  test('blocks IPv6 loopback, ULA, link-local and IPv4-mapped forms', () => {
    assert.match(classifyHost('::1') ?? '', /loopback/);
    assert.match(classifyHost('[::1]') ?? '', /loopback/);
    assert.match(classifyHost('fc00::1') ?? '', /unique local/);
    assert.match(classifyHost('fd12:3456::1') ?? '', /unique local/);
    assert.match(classifyHost('fe80::1') ?? '', /link-local/);
    assert.match(classifyHost('::ffff:127.0.0.1') ?? '', /loopback/);
    assert.match(classifyHost('::ffff:169.254.169.254') ?? '', /metadata/);
  });

  test('allows public IPv6', () => {
    assert.equal(classifyHost('2606:4700::1111'), null);
    assert.equal(classifyHost('2a00:1450:4001:81f::200e'), null);
  });

  test('handles the trailing-dot form', () => {
    assert.match(classifyHost('localhost.') ?? '', /localhost/);
  });
});

describe('URL validation', () => {
  test('rejects non-http schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://example.com',
      'ftp://example.com',
      'data:text/html,<h1>x</h1>',
    ]) {
      assert.throws(() => validateUrl(url, DEFAULT_POLICY), SsrfError, `${url} must be rejected`);
    }
  });

  test('rejects credentials in the URL', () => {
    assert.throws(
      () => validateUrl('https://user:pass@example.com', DEFAULT_POLICY),
      /credentials/,
    );
  });

  test('rejects private targets by default', () => {
    assert.throws(() => validateUrl('http://127.0.0.1:8080', DEFAULT_POLICY), /loopback/);
    assert.throws(() => validateUrl('http://169.254.169.254/latest/meta-data', DEFAULT_POLICY), /metadata/);
  });

  test('allows private targets when the operator opts in (Docker case)', () => {
    const policy = { ...DEFAULT_POLICY, allowPrivateTargets: true };
    assert.doesNotThrow(() => validateUrl('http://localhost:3000', policy));
    assert.doesNotThrow(() => validateUrl('http://10.0.0.5/health', policy));
  });

  test('DNS resolution is re-checked to close the rebinding gap', async () => {
    // 127.0.0.1.nip.io is a public hostname that resolves to loopback.
    await assert.rejects(
      () =>
        assertAllowed('http://127.0.0.1.nip.io/', DEFAULT_POLICY, async () => ['127.0.0.1']),
      /resolves to 127\.0\.0\.1/,
    );
  });

  test('a resolver returning a public address is allowed', async () => {
    const url = await assertAllowed('https://example.com', DEFAULT_POLICY, async () => [
      '93.184.216.34',
    ]);
    assert.equal(url.hostname, 'example.com');
  });
});

/** Canned 200 response used across both engine suites. */
const ok = (status = 200, body = 'hi') =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });

describe('HTTP monitor engine', () => {

  test('invokes fetch without a receiver', async () => {
    // `fetch` is a native binding in workerd and throws "Illegal invocation:
    // function called with incorrect `this` reference" the moment it is called
    // as a method. Node's `fetch` ignores `this`, so the bug survives the whole
    // suite and only breaks a deployed Worker. Detecting the receiver with a
    // plain function is the only way to catch it here — every existing test
    // injects an arrow function, which cannot observe its own receiver.
    let receiver: unknown = 'never called';
    const spy = function (this: unknown) {
      receiver = this;
      return Promise.resolve(ok());
    };

    const result = await runCheck(monitor(), { fetchImpl: spy as unknown as typeof fetch });

    assert.equal(result.status, 'up');
    assert.equal(
      receiver,
      undefined,
      'fetch was called with a receiver; workerd would reject this with Illegal invocation',
    );
  });

  test('reports up for a 200 in range', async () => {
    const result = await runCheck(monitor(), { fetchImpl: async () => ok() });
    assert.equal(result.status, 'up');
    assert.equal(result.statusCode, 200);
    assert.equal(result.errorMessage, null);
  });

  test('reports down for an unexpected status', async () => {
    const result = await runCheck(monitor(), { fetchImpl: async () => ok(503) });
    assert.equal(result.status, 'down');
    assert.match(result.errorMessage ?? '', /outside 200-299/);
  });

  test('honours a custom expected status range', async () => {
    const result = await runCheck(
      monitor({ expected_status_min: 200, expected_status_max: 299 }),
      { fetchImpl: async () => ok(404) },
    );
    assert.equal(result.status, 'down');
  });

  test('downgrades to degraded when latency exceeds the warning threshold', async () => {
    let clock = 0;
    const result = await runCheck(monitor({ latency_warn_ms: 100 }), {
      // 250ms of "work" between the two clock reads.
      now: () => {
        const value = clock;
        clock += 125;
        return value;
      },
      fetchImpl: async () => {
        clock += 125;
        return ok();
      },
    });
    assert.equal(result.status, 'degraded');
    assert.match(result.errorMessage ?? '', /slow/);
  });

  test('latency_fail_ms forces down, overriding degraded', async () => {
    let clock = 0;
    const result = await runCheck(
      monitor({ latency_warn_ms: 50, latency_fail_ms: 200 }),
      {
        now: () => {
          const value = clock;
          clock += 300;
          return value;
        },
        fetchImpl: async () => ok(),
      },
    );
    assert.equal(result.status, 'down');
    assert.match(result.errorMessage ?? '', /limit/);
  });

  test('surfaces transport errors as down', async () => {
    const result = await runCheck(monitor(), {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(result.status, 'down');
    assert.match(result.errorMessage ?? '', /ECONNREFUSED/);
  });

  test('retries transient failures and succeeds on a later attempt', async () => {
    let attempts = 0;
    const result = await runCheck(monitor({ retries: 2 }), {
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('network blip');
        return ok();
      },
    });
    assert.equal(attempts, 3);
    assert.equal(result.status, 'up');
  });

  test('caps response body reads', async () => {
    const result = await runCheck(monitor({ max_response_bytes: 1024 }), {
      fetchImpl: async () => new Response('x'.repeat(50_000), { status: 200 }),
    });
    // The body is discarded by the HTTP path, but the check must still succeed
    // without attempting to buffer 50 KB against a 1 KB cap.
    assert.equal(result.status, 'up');
  });

  test('follows redirects and re-validates each hop', async () => {
    const seen: string[] = [];
    const result = await runCheck(monitor({ url: 'https://example.com/start' }), {
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        if (url.includes('/start')) {
          return new Response(null, { status: 302, headers: { location: '/final' } });
        }
        return ok();
      },
    });
    assert.deepEqual(seen, ['https://example.com/start', 'https://example.com/final']);
    assert.equal(result.status, 'up');
  });

  test('strips Authorization when a redirect crosses hosts', async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    await runCheck(
      monitor({
        url: 'https://example.com/start',
        headers: JSON.stringify({ Authorization: 'Bearer secret', 'X-Keep': 'yes' }),
      }),
      {
        fetchImpl: async (input, init) => {
          seenHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
          if (String(input).includes('/start')) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://other.example.org/final' },
            });
          }
          return ok();
        },
      },
    );
    assert.equal(seenHeaders[0]!.Authorization, 'Bearer secret');
    assert.equal(seenHeaders[1]!.Authorization, undefined, 'must not leak across origins');
    assert.equal(seenHeaders[1]!['X-Keep'], 'yes', 'non-sensitive headers survive');
  });

  test('does not follow redirects when disabled', async () => {
    let calls = 0;
    const result = await runCheck(monitor({ follow_redirects: false }), {
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'down');
  });

  test('a redirect into a blocked range is refused', async () => {
    await assert.rejects(
      () =>
        runCheck(monitor({ url: 'https://example.com/start' }), {
          fetchImpl: async (input) =>
            String(input).includes('/start')
              ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
              : ok(),
        }),
      /disallowed target/,
    );
  });

  test('respects the timeout via AbortController', async () => {
    const result = await runCheck(monitor({ timeout_ms: 1000 }), {
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });
    assert.equal(result.status, 'down');
    assert.match(result.errorMessage ?? '', /timed out/i);
  });
});

describe('DSL monitor engine', () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  test('chains steps and extracts variables', async () => {
    const script = JSON.stringify({
      steps: [
        {
          name: 'login',
          request: { method: 'POST', url: 'https://api.example.com/login' },
          extract: { token: 'json.token' },
        },
        {
          name: 'profile',
          request: {
            method: 'GET',
            url: 'https://api.example.com/me',
            headers: { Authorization: 'Bearer ${token}' },
          },
          assert: [{ check: 'status', equals: 200 }, { check: 'json.id', greaterThan: 0 }],
        },
      ],
    });

    const seen: Array<{ url: string; auth: string | undefined }> = [];

    const result = await runCheck(monitor({ kind: 'dsl', script, url: null }), {
      fetchImpl: async (input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url: String(input), auth: headers.Authorization });
        if (String(input).includes('login')) return json({ token: 'abc123' });
        return json({ id: 42 });
      },
    });

    assert.equal(result.status, 'up');
    assert.equal(seen[1]!.auth, 'Bearer abc123', 'variable must interpolate into headers');
    assert.equal(result.steps?.length, 2);
  });

  test('marks a failed assertion down and reports the step', async () => {
    const script = JSON.stringify({
      steps: [
        {
          name: 'health',
          request: { method: 'GET', url: 'https://api.example.com/health' },
          assert: [{ check: 'status', equals: 200 }],
        },
      ],
    });

    const result = await runCheck(monitor({ kind: 'dsl', script, url: null }), {
      fetchImpl: async () => json({ ok: false }, 500),
    });

    assert.equal(result.status, 'down');
    assert.match(result.errorMessage ?? '', /status/);
    assert.equal(result.steps?.[0]?.ok, false);
  });

  test('honours per-assertion degraded severity', async () => {
    const script = JSON.stringify({
      steps: [
        {
          name: 'slow',
          request: { method: 'GET', url: 'https://api.example.com/slow' },
          assert: [{ check: 'status', greaterThan: 299, severity: 'degraded' }],
        },
      ],
    });

    const result = await runCheck(monitor({ kind: 'dsl', script, url: null }), {
      fetchImpl: async () => ok(200),
    });
    assert.equal(result.status, 'degraded');
  });

  test('a missing variable is left as a literal, not substituted with undefined', async () => {
    const script = JSON.stringify({
      steps: [
        {
          name: 'needs-token',
          request: {
            method: 'GET',
            url: 'https://api.example.com/x',
            headers: { Authorization: 'Bearer ${nope}' },
          },
        },
      ],
    });

    let seenAuth: string | undefined;
    await runCheck(monitor({ kind: 'dsl', script, url: null }), {
      fetchImpl: async (_input, init) => {
        seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
        return ok();
      },
    });
    assert.equal(seenAuth, 'Bearer ${nope}');
  });

  test('reports malformed JSON as down without throwing', async () => {
    const result = await runCheck(
      monitor({ kind: 'dsl', script: '{not json', url: null }),
      { fetchImpl: async () => ok() },
    );
    assert.equal(result.status, 'down');
    assert.match(result.errorMessage ?? '', /not valid JSON/);
  });

  test('stops after a transport failure instead of running later steps', async () => {
    const script = JSON.stringify({
      steps: [
        { name: 'a', request: { method: 'GET', url: 'https://api.example.com/a' } },
        { name: 'b', request: { method: 'GET', url: 'https://api.example.com/b' } },
      ],
    });

    let calls = 0;
    const result = await runCheck(monitor({ kind: 'dsl', script, url: null }), {
      fetchImpl: async () => {
        calls += 1;
        throw new Error('boom');
      },
    });

    assert.equal(calls, 1, 'must not attempt step b');
    assert.equal(result.status, 'down');
  });
});

describe('assertion evaluation', () => {
  const context = {
    status: 200,
    body: '{"a":{"b":[1,2,3]},"ok":true}',
    json: { a: { b: [1, 2, 3] }, ok: true },
    headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
    responseTime: 120,
  };

  const evaluate = (assertion: Parameters<typeof evaluateAssertion>[0]) =>
    evaluateAssertion(assertion, context);

  test('reads nested json paths and array indexes', () => {
    assert.equal(evaluate({ check: 'json.a.b.0', equals: 1 }).passed, true);
    assert.equal(evaluate({ check: 'json.a.b', contains: '2' }).passed, true);
    assert.equal(evaluate({ check: 'json.ok', equals: true }).passed, true);
  });

  test('reads headers case-insensitively', () => {
    assert.equal(evaluate({ check: 'header.X-Request-Id', equals: 'abc' }).passed, true);
    assert.equal(evaluate({ check: 'header.content-type', contains: 'json' }).passed, true);
  });

  test('compares numbers numerically, not lexically', () => {
    assert.equal(evaluate({ check: 'responseTime', greaterThan: 100 }).passed, true);
    assert.equal(evaluate({ check: 'status', lessThanOrEqual: 200 }).passed, true);
  });

  test('treats a numeric status as equal to its string form', () => {
    assert.equal(evaluate({ check: 'status', equals: '200' }).passed, true);
  });

  test('reports exists / notContains correctly', () => {
    assert.equal(evaluate({ check: 'header.missing', exists: false }).passed, true);
    assert.equal(evaluate({ check: 'body', notContains: 'zzz' }).passed, true);
  });

  test('supports regex matching', () => {
    assert.equal(evaluate({ check: 'header.x-request-id', matches: '^a.*c$' }).passed, true);
  });

  test('an invalid regex fails the assertion rather than throwing', () => {
    assert.equal(evaluate({ check: 'body', matches: '([' }).passed, false);
  });

  test('flags an assertion with no operator', () => {
    assert.equal(evaluate({ check: 'status' }).passed, false);
  });
});
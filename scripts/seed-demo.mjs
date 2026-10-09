#!/usr/bin/env node
/**
 * Seed a local database with realistic demo data.
 *
 * Purpose: let someone actually *see* the dashboard — charts, uptime bars and
 * the edge map are meaningless against an empty table, and a screenshot of an
 * empty state proves nothing about the UI.
 *
 * Everything is written through the real API where possible, so seeding also
 * exercises the validation and SSRF layers rather than bypassing them.
 *
 *   node scripts/seed-demo.mts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';

const CREDENTIALS = {
  email: 'demo@pulsepost.local',
  password: 'demo-Instance-2026!',
};

let cookie = '';

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

/** Monitors chosen to exercise every visual state the UI can render. */
const MONITORS = [
  { name: 'Marketing site', url: 'https://example.com', tone: 'up' },
  { name: 'API gateway', url: 'https://httpbin.org/status/200', tone: 'up', latency: 120 },
  { name: 'Auth service', url: 'https://httpbin.org/status/200', tone: 'up', latency: 68 },
  { name: 'Image CDN', url: 'https://httpbin.org/status/200', tone: 'degraded', latency: 1400 },
  { name: 'Billing webhook', url: 'https://httpbin.org/status/503', tone: 'down' },
  { name: 'Docs', url: 'https://example.com/docs', tone: 'up', paused: true },
  {
    name: 'Checkout flow',
    kind: 'dsl',
    tone: 'up',
    script: {
      steps: [
        {
          name: 'login',
          request: { method: 'POST', url: 'https://httpbin.org/status/200' },
          extract: { token: 'json.token' },
        },
        {
          name: 'charge',
          request: {
            method: 'POST',
            url: 'https://httpbin.org/status/201',
            headers: { Authorization: 'Bearer ${token}' },
          },
          assert: [{ check: 'status', equals: 201 }],
        },
      ],
    },
  },
];

async function main() {
  console.log(`Seeding ${BASE}`);

  // 1. Account. Tolerate "already set up" so the script is re-runnable.
  const setup = await call('/api/auth/setup', {
    method: 'POST',
    body: {
      name: 'Demo Operator',
      ...CREDENTIALS,
      app_name: 'Acme Platform',
    },
  });

  if (setup.status === 201) {
    console.log('  created admin account');
  } else if (setup.status === 409) {
    console.log('  already set up — logging in');
    const login = await call('/api/auth/login', { method: 'POST', body: CREDENTIALS });
    if (login.status !== 200) {
      console.error(`  login failed: ${login.status}`, login.json?.error);
      process.exit(1);
    }
  } else {
    console.error(`  setup failed: ${setup.status}`, setup.json);
    process.exit(1);
  }

  // 2. Groups. A group marked public is what /status publishes, so without
  //    this the public status page has nothing to show.
  const existingGroups = await call('/api/groups');
  let groupId = (existingGroups.json?.groups ?? []).find((g) => g.name === 'Core services')?.id;

  if (!groupId) {
    const group = await call('/api/groups', {
      method: 'POST',
      body: {
        name: 'Core services',
        slug: 'core',
        description: 'Everything customers hit directly',
        is_public: true,
        display_order: 0,
      },
    });
    if (group.status === 201) {
      groupId = group.json.group.id;
      console.log('  + group: Core services (public)');
    } else {
      console.log(`  ! group -> ${group.status} ${group.json?.error ?? ''}`);
    }
  }

  // 3. Monitors.
  const existing = await call('/api/monitors');
  const alreadyThere = new Set((existing.json?.monitors ?? []).map((m) => m.name));

  const created = [];
  for (const spec of MONITORS) {
    if (alreadyThere.has(spec.name)) continue;

    const body = spec.kind === 'dsl'
      ? {
          name: spec.name,
          kind: 'dsl',
          script: JSON.stringify(spec.script),
          interval_seconds: 300,
          group_id: groupId,
        }
      : {
          name: spec.name,
          url: spec.url,
          method: 'GET',
          interval_seconds: 300,
          group_id: groupId,
          ...(spec.latency && spec.latency > 800
            ? { latency_warn_ms: 800, latency_fail_ms: 5000 }
            : {}),
        };

    const result = await call('/api/monitors', { method: 'POST', body });
    if (result.status === 201) {
      created.push({ id: result.json.monitor.id, ...spec });
      console.log(`  + ${spec.name}`);
    } else {
      console.log(`  ! ${spec.name} -> ${result.status} ${result.json?.error ?? ''}`);
    }
  }

  if (created.length === 0) {
    console.log('nothing new to seed');
    return;
  }

  console.log(`\nDone. ${created.length} monitor(s) created.`);
  console.log(`Sign in at ${BASE} with ${CREDENTIALS.email} / ${CREDENTIALS.password}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
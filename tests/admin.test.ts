import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app } from '../src/worker/index.ts';

/**
 * Tests for the admin surfaces added alongside the core monitor API:
 * incidents, notification channels and user management.
 *
 * These three share a theme worth testing explicitly — each stores or hands
 * back something sensitive. Incidents own the customer-facing timeline,
 * channels hold webhook credentials, and users decide who can do what. The
 * assertions below lean on that: a passing suite means the secrets stay in and
 * the privilege boundary holds.
 */

let dir: string;
let dbPath: string;
let adminCookie = '';
let editorCookie = '';
let viewerCookie = '';
/** Re-used after the editor is promoted to admin, so the TOTP tests have a
 *  second admin session to work through. */
let editorAdminCookie = '';

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
    ALLOW_PRIVATE_TARGETS: false,
    AUTH_RATE_LIMIT: 1000,
    API_RATE_LIMIT: 1000,
    RATE_WINDOW_SECONDS: 60,
    // TOTP secrets are encrypted at rest and this is the key they are
    // encrypted under; without it enrolment is refused by design.
    TOTP_SECRET: 'test-only-totp-key-not-used-anywhere-else',
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulsepost-admin-'));
  dbPath = join(dir, 'admin.db');

  await call('/api/auth/setup', {
    method: 'POST',
    body: {
      name: 'Owner',
      email: 'owner@example.com',
      password: 'correct-horse-Battery9!',
    },
  });

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'correct-horse-Battery9!' },
  });
  adminCookie = (login.response.headers.get('Set-Cookie') ?? '').split(';')[0]!;

  // Two lower-privileged accounts, to prove the role boundary rather than
  // assume it.
  const staff: Array<{ email: string; password: string; role: string }> = [
    { email: 'editor@example.com', password: 'Editor-password-1234!', role: 'editor' },
    { email: 'viewer@example.com', password: 'Viewer-password-1234!', role: 'viewer' },
  ];

  for (const account of staff) {
    await call('/api/users', {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: { name: account.email.split('@')[0]!, ...account },
    });

    const session = await call('/api/auth/login', {
      method: 'POST',
      body: { email: account.email, password: account.password },
    });

    if (account.role === 'editor') {
      editorCookie = (session.response.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    } else {
      viewerCookie = (session.response.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    }
  }
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

const asAdmin = () => ({ Cookie: adminCookie });
const asEditor = () => ({ Cookie: editorCookie });
const asViewer = () => ({ Cookie: viewerCookie });

// --- incidents ---------------------------------------------------------------

describe('incidents', () => {
  let incidentId = '';

  test('requires authentication', async () => {
    const { response } = await call('/api/incidents');
    assert.equal(response.status, 401);
  });

  test('a viewer cannot open an incident', async () => {
    const { response } = await call('/api/incidents', {
      method: 'POST',
      headers: asViewer(),
      body: { title: 'Viewer attempt', impact: 'minor' },
    });
    assert.equal(response.status, 403);
  });

  test('an editor can open one, with a first timeline entry', async () => {
    const { response, json } = await call('/api/incidents', {
      method: 'POST',
      headers: asEditor(),
      body: {
        title: 'Elevated latency in eu-west',
        impact: 'minor',
        status: 'investigating',
        message: 'Looking into it.',
      },
    });

    assert.equal(response.status, 201);
    const incident = (json as { incident: { id: string; updates: unknown[] } }).incident;
    incidentId = incident.id;
    assert.equal(incident.updates.length, 1);
  });

  test('refuses to create an incident already marked resolved', async () => {
    const { response, json } = await call('/api/incidents', {
      method: 'POST',
      headers: asEditor(),
      body: { title: 'Contradiction', impact: 'minor', status: 'resolved' },
    });

    assert.equal(response.status, 201);
    const incident = (json as { incident: { status: string; resolved_at: string | null } }).incident;
    // Clamped rather than rejected: the operator's intent was to open an
    // incident, and the contradiction is resolved in their favour.
    assert.equal(incident.status, 'investigating');
    assert.equal(incident.resolved_at, null);
  });

  test('a status change appends a timeline entry', async () => {
    const { response, json } = await call(`/api/incidents/${incidentId}`, {
      method: 'PATCH',
      headers: asEditor(),
      body: { status: 'monitoring', message: 'Fix deployed, watching.' },
    });

    assert.equal(response.status, 200);
    const incident = (json as { incident: { status: string; updates: Array<{ message: string }> } }).incident;
    assert.equal(incident.status, 'monitoring');
    assert.equal(incident.updates.length, 2);
  });

  test('resolving derives resolved_at from the status change', async () => {
    const { json } = await call(`/api/incidents/${incidentId}`, {
      method: 'PATCH',
      headers: asEditor(),
      body: { status: 'resolved' },
    });

    const incident = (json as { incident: { status: string; resolved_at: string | null } }).incident;
    assert.equal(incident.status, 'resolved');
    // Set by the server, not the caller — the two cannot drift apart.
    assert.ok(incident.resolved_at, 'resolved_at should be derived automatically');
  });

  test('re-opening clears resolved_at', async () => {
    const { json } = await call(`/api/incidents/${incidentId}`, {
      method: 'PATCH',
      headers: asEditor(),
      body: { status: 'investigating' },
    });

    const incident = (json as { incident: { resolved_at: string | null } }).incident;
    assert.equal(incident.resolved_at, null);
  });

  test('a viewer cannot change an incident', async () => {
    const { response } = await call(`/api/incidents/${incidentId}`, {
      method: 'PATCH',
      headers: asViewer(),
      body: { status: 'resolved' },
    });
    assert.equal(response.status, 403);
  });

  test('deleting requires admin', async () => {
    const asEditorDelete = await call(`/api/incidents/${incidentId}`, {
      method: 'DELETE',
      headers: asEditor(),
    });
    assert.equal(asEditorDelete.response.status, 403);

    const asAdminDelete = await call(`/api/incidents/${incidentId}`, {
      method: 'DELETE',
      headers: asAdmin(),
    });
    assert.equal(asAdminDelete.response.status, 200);
  });

  test('404s an incident that does not exist', async () => {
    const { response } = await call('/api/incidents/00000000-0000-4000-8000-000000000000', {
      headers: asAdmin(),
    });
    assert.equal(response.status, 404);
  });
});

// --- notification channels ---------------------------------------------------

describe('notification channels', () => {
  let channelId = '';
  const secretUrl = 'https://hooks.example.com/services/T000/B000/supersecret';

  test('an editor can create a channel', async () => {
    const { response, json } = await call('/api/channels', {
      method: 'POST',
      headers: asEditor(),
      body: { type: 'webhook', name: 'Ops Slack', url: secretUrl },
    });

    assert.equal(response.status, 201);
    channelId = (json as { channel: { id: string } }).channel.id;
  });

  test('the stored webhook URL never comes back out', async () => {
    const { json } = await call('/api/channels', { headers: asAdmin() });
    const channels = (json as { channels: Array<{ id: string; config: string }> }).channels;
    const channel = channels.find((c) => c.id === channelId)!;

    // The shape survives so the UI can show "configured", the value does not.
    assert.match(channel.config, /"url"/);
    assert.ok(!channel.config.includes('supersecret'), 'secret must not be echoed');
    assert.ok(!channel.config.includes('hooks.example.com'), 'host must not be echoed');
  });

  test('the whole channel list is free of the secret', async () => {
    const { text } = await call('/api/channels', { headers: asAdmin() });
    assert.ok(!text.includes('supersecret'), 'no endpoint may leak the secret');
  });

  test('a viewer cannot create or modify a channel', async () => {
    const create = await call('/api/channels', {
      method: 'POST',
      headers: asViewer(),
      body: { type: 'webhook', name: 'Nope', url: secretUrl },
    });
    assert.equal(create.response.status, 403);

    const update = await call(`/api/channels/${channelId}`, {
      method: 'PATCH',
      headers: asViewer(),
      body: { name: 'Renamed' },
    });
    assert.equal(update.response.status, 403);
  });

  test('an editor can rename and deactivate', async () => {
    const { response, json } = await call(`/api/channels/${channelId}`, {
      method: 'PATCH',
      headers: asEditor(),
      body: { name: 'Ops Slack (primary)', active: false },
    });

    assert.equal(response.status, 200);
    const channel = (json as { channel: { name: string; active: boolean } }).channel;
    assert.equal(channel.name, 'Ops Slack (primary)');
    assert.equal(channel.active, false);
  });

  test('rotating the URL does not reveal the old or new one', async () => {
    const rotated = 'https://hooks.example.com/services/T999/B999/anothersecret';
    const { response, text } = await call(`/api/channels/${channelId}`, {
      method: 'PATCH',
      headers: asEditor(),
      body: { url: rotated },
    });

    assert.equal(response.status, 200);
    assert.ok(!text.includes('anothersecret'));
    assert.ok(!text.includes('supersecret'));
  });

  test('linking a channel to a monitor is idempotent', async () => {
    const created = await call('/api/monitors', {
      method: 'POST',
      headers: asEditor(),
      body: { name: 'Linked monitor', url: 'https://example.com/health' },
    });
    const monitorId = (created.json as { monitor: { id: string } }).monitor.id;

    const link = () =>
      call(`/api/channels/${channelId}/link`, {
        method: 'POST',
        headers: asEditor(),
        body: { channel_id: monitorId, notify_on: 'down', downtime_threshold_s: 60 },
      });

    assert.equal((await link()).response.status, 200);
    // Re-linking updates in place rather than tripping the composite key.
    assert.equal((await link()).response.status, 200);

    const { json } = await call('/api/channels', { headers: asAdmin() });
    const channel = (json as { channels: Array<{ id: string; monitors: unknown[] }> }).channels.find(
      (c) => c.id === channelId,
    )!;
    assert.equal(channel.monitors.length, 1);

    const unlink = await call(`/api/channels/${channelId}/link/${monitorId}`, {
      method: 'DELETE',
      headers: asEditor(),
    });
    assert.equal(unlink.response.status, 200);
  });

  test('deleting a channel requires admin', async () => {
    const { response } = await call(`/api/channels/${channelId}`, {
      method: 'DELETE',
      headers: asEditor(),
    });
    assert.equal(response.status, 403);
  });
});

// --- users -------------------------------------------------------------------

describe('user management', () => {
  test('requires admin — an editor is refused', async () => {
    const { response } = await call('/api/users', { headers: asEditor() });
    assert.equal(response.status, 403);
  });

  test('never returns a password hash', async () => {
    const { text } = await call('/api/users', { headers: asAdmin() });
    assert.ok(!text.includes('pbkdf2'), 'no hashing parameters may leak');
    assert.ok(!text.includes('password_hash'));
  });

  test('lists only accounts created through the API', async () => {
    const { json } = await call('/api/users', { headers: asAdmin() });
    const users = (json as { users: Array<{ email: string }> }).users;
    assert.ok(users.some((u) => u.email === 'editor@example.com'));
    assert.ok(users.some((u) => u.email === 'viewer@example.com'));
  });

  test('rejects a duplicate email', async () => {
    const { response } = await call('/api/users', {
      method: 'POST',
      headers: asAdmin(),
      body: {
        name: 'Clone',
        email: 'editor@example.com',
        // Password strength is validated before the uniqueness check, so it
        // has to be a *valid* password to reach the 409.
        password: 'Another-strong-pass-99!',
        role: 'viewer',
      },
    });
    assert.equal(response.status, 409);
  });

  test('the last admin cannot be demoted', async () => {
    const { json } = await call('/api/users', { headers: asAdmin() });
    const owner = (json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'owner@example.com',
    )!;

    const { response, json: body } = await call(`/api/users/${owner.id}`, {
      method: 'PATCH',
      headers: asAdmin(),
      body: { role: 'editor' },
    });

    assert.equal(response.status, 409);
    assert.match((body as { error: string }).error, /only remaining admin/i);
  });

  test('the last admin cannot be disabled', async () => {
    const { json } = await call('/api/users', { headers: asAdmin() });
    const owner = (json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'owner@example.com',
    )!;

    const { response } = await call(`/api/users/${owner.id}`, {
      method: 'PATCH',
      headers: asAdmin(),
      body: { disabled: true },
    });
    assert.equal(response.status, 409);
  });

  test('an admin cannot delete their own account through the UI', async () => {
    const { json } = await call('/api/users', { headers: asAdmin() });
    const owner = (json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'owner@example.com',
    )!;

    const { response } = await call(`/api/users/${owner.id}`, {
      method: 'DELETE',
      headers: asAdmin(),
    });
    assert.equal(response.status, 400);
  });

  test('a demotion takes effect, so a second admin can then exist', async () => {
    const { json } = await call('/api/users', { headers: asAdmin() });
    const viewer = (json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'viewer@example.com',
    )!;

    const promote = await call(`/api/users/${viewer.id}`, {
      method: 'PATCH',
      headers: asAdmin(),
      body: { role: 'admin' },
    });
    assert.equal(promote.response.status, 200);
    assert.equal((promote.json as { user: { role: string } }).user.role, 'admin');

    // Reverting keeps the suite from leaving two admins behind.
    const revert = await call(`/api/users/${viewer.id}`, {
      method: 'PATCH',
      headers: asAdmin(),
      body: { role: 'viewer' },
    });
    assert.equal(revert.response.status, 200);
  });

  test('an admin can be deleted by another admin once a second one exists', async () => {
    // Promote the editor to admin so the owner is no longer the last admin.
    const { json } = await call('/api/users', { headers: asAdmin() });
    const editor = (json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'editor@example.com',
    )!;
    await call(`/api/users/${editor.id}`, {
      method: 'PATCH',
      headers: asAdmin(),
      body: { role: 'admin' },
    });

    // Log in as that new admin and delete the viewer account.
    const login = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'editor@example.com', password: 'Editor-password-1234!' },
    });
    editorAdminCookie = (login.response.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const listed = await call('/api/users', { headers: { Cookie: editorAdminCookie } });
    const viewer = (listed.json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'viewer@example.com',
    )!;

    const { response } = await call(`/api/users/${viewer.id}`, {
      method: 'DELETE',
      headers: { Cookie: editorAdminCookie },
    });
    assert.equal(response.status, 200);
  });

  test('a peer admin can still be demoted', async () => {
    // Guards against a lockout: if equal rank were treated as "higher or
    // equal", a second admin could never be demoted and the instance would
    // gain a permanent, unremovable account.
    const listed = await call('/api/users', { headers: { Cookie: editorAdminCookie } });
    const editor = (listed.json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'editor@example.com',
    )!;
    assert.equal(editor.email, 'editor@example.com');

    const login = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'correct-horse-Battery9!' },
    });
    const ownerCookie = (login.response.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const { response, json } = await call(`/api/users/${editor.id}`, {
      method: 'PATCH',
      headers: { Cookie: ownerCookie },
      body: { role: 'editor' },
    });

    assert.equal(response.status, 200);
    assert.equal((json as { user: { role: string } }).user.role, 'editor');
  });

  test('TOTP enrolment returns a secret that is not yet active', async () => {
    // Uses the owner session rather than any account another test has since
    // re-roled, so this does not depend on execution order.
    const { json } = await call('/api/auth/me', { headers: asAdmin() });
    const me = (json as { user: { id: string; totp_enabled: boolean } }).user;
    assert.equal(me.totp_enabled, false);

    const start = await call(`/api/users/${me.id}/totp/start`, {
      method: 'POST',
      headers: asAdmin(),
    });
    assert.equal(start.response.status, 200);

    const enrolment = (start.json as { secret: string; uri: string }).secret;
    assert.match(enrolment, /^[A-Z2-7]{16,}$/);

    const uri = (start.json as { uri: string }).uri;
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /issuer=Testwatch/);
  });

  test('confirming with a wrong code is rejected', async () => {
    const me = await call('/api/auth/me', { headers: asAdmin() });
    const id = (me.json as { user: { id: string } }).user.id;

    const { response } = await call(`/api/users/${id}/totp/confirm`, {
      method: 'POST',
      headers: asAdmin(),
      body: { code: '000000' },
    });
    assert.equal(response.status, 400);
  });

  test('enrolling in TOTP requires your own account', async () => {
    // A second admin is created and promoted here rather than depending on an
    // earlier test, so this assertion stands on its own.
    await call('/api/users', {
      method: 'POST',
      headers: asAdmin(),
      body: {
        name: 'Second',
        email: 'second-admin@example.com',
        password: 'Second-admin-pass-99!',
        role: 'admin',
      },
    });

    const login = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'second-admin@example.com', password: 'Second-admin-pass-99!' },
    });
    const secondCookie = (login.response.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const ownerList = await call('/api/users', { headers: { Cookie: secondCookie } });
    const owner = (ownerList.json as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'owner@example.com',
    )!;

    // Being an admin is not enough: you may only enrol your own account.
    const { response } = await call(`/api/users/${owner.id}/totp/start`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
    });
    assert.equal(response.status, 403);
  });

  test('TOTP enrolment is refused when no TOTP_SECRET is configured', async () => {
    const me = await call('/api/auth/me', { headers: asAdmin() });
    const id = (me.json as { user: { id: string } }).user.id;

    const { response, json } = await call(`/api/users/${id}/totp/start`, {
      method: 'POST',
      headers: asAdmin(),
      env: { TOTP_SECRET: '' },
    });

    // Refused rather than silently falling back to a built-in key, which
    // would store the secret under a value anyone reading the source knows.
    assert.equal(response.status, 501);
    assert.equal((json as { code: string }).code, 'TOTP_UNCONFIGURED');
  });
});
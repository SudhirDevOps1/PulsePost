import { Hono } from 'hono';
import { cors, preflight } from './middleware/cors.ts';
import { apiHeaders, securityHeaders } from './middleware/security.ts';
import { withDatabase, resolveIdentity, requireAuth, type AppEnv } from './middleware/context.ts';
import { apiRateLimit } from './middleware/ratelimit.ts';
import { HttpError, toErrorBody } from './http/errors.ts';
import { loadConfig } from './config.ts';
import { authRoutes } from './routes/auth.ts';
import { monitorRoutes } from './routes/monitors.ts';
import { groupRoutes } from './routes/groups.ts';
import { incidentRoutes } from './routes/incidents.ts';
import { channelRoutes } from './routes/channels.ts';
import { userRoutes } from './routes/users.ts';
import { publicRoutes } from './routes/status.ts';
import { runSweep } from './checkers/sweep.ts';
import { hmacEqual } from './auth/password.ts';
import { nowIso } from './db/dialect.ts';
import type { RequestCf } from './util/ip.ts';

/**
 * The unified Worker: one module serves the React SPA, the JSON API, and the
 * cron sweep.
 *
 * This is the single-Worker requirement made concrete — there is no second
 * service, no separate API host, and no origin the frontend cannot reach. The
 * frontend calls `/api/*` on its own origin, so there is no CORS in the happy
 * path and no preflight round-trip.
 */

const app = new Hono<AppEnv>();

// --- global middleware -------------------------------------------------------

app.use('*', preflight());

app.use('*', async (c, next) => {
  const config = loadConfig(c.env as Record<string, unknown>);
  await next();
  securityHeaders(config)(c, async () => undefined);
});

// CORS needs the config, so it reads it directly rather than from `c`.
app.use('*', async (c, next) => {
  const config = loadConfig(c.env as Record<string, unknown>);
  await cors(config.corsOrigins)(c, next);
});

app.use('/api/*', apiHeaders());
app.use('/api/*', withDatabase());
app.use('/api/*', resolveIdentity());

// --- routes ------------------------------------------------------------------

app.route('/api/auth', authRoutes);
app.route('/api/monitors', monitorRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/incidents', incidentRoutes);
app.route('/api/channels', channelRoutes);
app.route('/api/users', userRoutes);
app.route('/api/public', publicRoutes);

/** Liveness/readiness, including which database provider is live. */
app.get('/api/health', withDatabase(), async (c) => {
  const db = c.get('db');
  const health = await db.healthCheck();

  return c.json(
    {
      ok: health.ok,
      database: {
        provider: health.provider,
        dialect: health.dialect,
        latency_ms: health.latencyMs,
        server_version: health.serverVersion,
        error: health.error,
      },
      version: c.get('config').version,
      environment: c.get('config').environment,
      timestamp: nowIso(),
    },
    health.ok ? 200 : 503,
  );
});

/**
 * Manual sweep trigger.
 *
 * Protected by `CRON_SECRET` via an HMAC comparison, so it cannot be used as a
 * free amplification vector for outbound requests. Intended for operators and
 * CI, not for the UI.
 */
app.get('/api/cron', apiRateLimit(), async (c) => {
  const config = c.get('config');

  const provided = c.req.header('X-Cron-Secret');
  if (!config.cronSecret || !provided || !(await hmacEqual(config.cronSecret, provided))) {
    throw new HttpError(403, 'Forbidden', 'CRON_FORBIDDEN');
  }

  const cf = (c.req.raw as { cf?: RequestCf }).cf;

  const result = await runSweep(c.get('db'), {
    checksPerRun: config.checksPerRun,
    rawCheckRetentionDays: config.rawCheckRetentionDays,
    dailyStatusRetentionDays: config.dailyStatusRetentionDays,
    maintenanceHourUtc: config.maintenanceHourUtc,
    appName: config.appName,
    colo: cf?.colo,
    region: cf?.city,
    allowPrivateTargets: config.allowPrivateTargets,
  });

  await c
    .get('db')
    .execute(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('last_sweep_at', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [nowIso(), nowIso()],
    )
    .catch(() => undefined);

  return c.json(result);
});

// --- SPA fallback ------------------------------------------------------------

/**
 * Hand anything that is not an API route to the static-asset handler, which
 * Workers Static Assets serves with `not_found_handling = "single-page-application"`.
 * Without this, client-side routes like `/status/team` would 404 on hard refresh.
 */
app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  const assets = c.env.ASSETS as Fetcher | undefined;
  if (!assets) {
    // Only reachable if `[assets]` was removed from wrangler.toml.
    return c.json(
      { error: 'Frontend assets are not configured', code: 'NO_ASSETS' },
      500,
    );
  }

  return assets.fetch(c.req.raw);
});

// --- error handling ----------------------------------------------------------

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

app.onError((error, c) => {
  const isProduction = loadConfig(c.env as Record<string, unknown>).environment === 'production';
  const { status, body } = toErrorBody(error, isProduction);

  if (status >= 500) {
    console.error('[api] unhandled error:', error);
  } else {
    console.warn(`[api] ${status} ${body.code}: ${body.error}`);
  }

  return c.json(body, status as 400);
});

// --- exported handlers -------------------------------------------------------

export interface WorkerEnv {
  DB?: unknown;
  HYPERDRIVE?: unknown;
  ASSETS: Fetcher;
  CRON_SECRET?: string;
  ENVIRONMENT?: string;
  [key: string]: unknown;
}

export default {
  fetch: app.fetch,

  /**
   * Cron entry point.
   *
   * Runs the sweep on every scheduled tick. Errors are caught so a single bad
   * monitor cannot abort the whole invocation — Cloudflare would otherwise log a
   * failed cron and delay the next run.
   */
  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const startedAt = Date.now();
    const config = loadConfig(env as Record<string, unknown>);

    console.log(`[cron] tick at ${new Date(startedAt).toISOString()} (${controller.cron})`);

    try {
      // Reuse the HTTP path so cron and manual triggers share one code path,
      // including auth and configuration handling.
      const result = await runSweepFor(env, config);

      console.log(
        `[cron] checked=${result.checked} up=${result.up} degraded=${result.degraded} down=${result.down} notified=${result.notified} in ${Date.now() - startedAt}ms`,
      );

      await persistSweepTime(env, result);
    } catch (error) {
      console.error('[cron] sweep failed:', error);
    }
  },
};

/** Build the sweep result without going through Hono's request plumbing. */
async function runSweepFor(env: WorkerEnv, config: ReturnType<typeof loadConfig>) {
  const { getDb } = await import('./db/index.ts');
  const db = await getDb(env as Record<string, unknown>);
  await db.migrate();

  return runSweep(db, {
    checksPerRun: config.checksPerRun,
    rawCheckRetentionDays: config.rawCheckRetentionDays,
    dailyStatusRetentionDays: config.dailyStatusRetentionDays,
    maintenanceHourUtc: config.maintenanceHourUtc,
    appName: config.appName,
    // A cron invocation has no request.cf, so results are recorded without a
    // colo and the map only fills in once HTTP-triggered checks have run.
    colo: undefined,
    region: undefined,
    allowPrivateTargets: config.allowPrivateTargets,
  });
}

async function persistSweepTime(
  env: WorkerEnv,
  result: { maintenance: string; durationMs: number },
): Promise<void> {
  const { getDb } = await import('./db/index.ts');
  try {
    const db = await getDb(env as Record<string, unknown>);
    const stamp = nowIso();
    await db.execute(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('last_sweep_at', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [stamp, stamp],
    );
  } catch (error) {
    console.warn('[cron] could not persist sweep time:', error);
  }
}

export { app, requireAuth };
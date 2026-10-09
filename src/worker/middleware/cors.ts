import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';

/**
 * CORS.
 *
 * This app is a same-origin SPA served by the same Worker, so CORS is not
 * needed for its own UI. It exists for two legitimate cases:
 *   - a status-page widget embedded on someone else's site
 *   - an external dashboard reading the read-only public API
 *
 * Therefore `CORS_ORIGINS` is an explicit allowlist and an empty value means
 * "same-origin only" — never "reflect any origin", which would let any site
 * read authenticated responses.
 */
export function cors(allowedOrigins: readonly string[]): MiddlewareHandler<AppEnv> {
  const allowed = new Set(allowedOrigins.map((origin) => origin.replace(/\/$/, '').toLowerCase()));

  return async (c, next) => {
    await next();

    const origin = c.req.header('Origin');

    // No Origin header: same-origin navigation or a non-browser client.
    if (!origin) return;

    const normalized = origin.replace(/\/$/, '').toLowerCase();
    const isAllowed = allowed.has(normalized) || allowed.has('*');

    // Always advertise that the header is variable-dependent so caches do not
    // reuse a response computed for a different origin.
    c.res.headers.append('Vary', 'Origin');

    if (!isAllowed) return;

    c.res.headers.set('Access-Control-Allow-Origin', allowed.has('*') ? '*' : origin);
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Cron-Secret');
    c.res.headers.set('Access-Control-Max-Age', '86400');
    // Credentials may only flow to an explicit origin, never with `*`.
    if (!allowed.has('*')) c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  };
}

/** Answer preflight requests before they reach a handler. */
export function preflight(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      await next();
      return c.body(null, 204);
    }
    await next();
  };
}
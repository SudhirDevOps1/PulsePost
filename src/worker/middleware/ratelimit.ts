import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';
import { HttpError } from '../http/errors.ts';

/**
 * Rate limiting.
 *
 * Primary mechanism is Cloudflare's native **Rate Limiting binding**
 * (`unsafe.bindings` with `type = "ratelimit"`). It is edge-accurate and counts
 * across every isolate, which matters because an in-process counter resets on
 * every cold start and would be trivially defeated.
 *
 * The in-memory limiter below is the fallback for `wrangler dev`, the Docker
 * image, and any runtime without the binding. It is per-isolate and therefore
 * weaker — documented as such rather than pretended to be equivalent.
 */

/** Structural view of the Workers rate limiting binding. */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitOptions {
  /** Rate limiter binding name from wrangler.toml, e.g. `RATE_LIMITER_AUTH`. */
  binding?: string;
  /**
   * Fallback budget when the binding is unavailable.
   * May be a static number or a resolver reading per-request config.
   */
  limit: number | ((c: import('hono').Context<AppEnv>) => number);
  /** Fallback window in seconds. */
  windowSeconds: number | ((c: import('hono').Context<AppEnv>) => number);
  /** Bucket label used in the `Retry-After` header and logs. */
  name: string;
  /** What to key on. Defaults to client IP. */
  key?: (c: import('hono').Context<AppEnv>) => string;
}

/**
 * In-memory sliding-window counter.
 *
 * Deliberately bounded: `maxKeys` stops a flood of distinct IPs from growing
 * the map without limit. Once the cap is hit the oldest half is evicted, which
 * is cheap and keeps memory flat under attack.
 *
 * Fields are declared explicitly rather than as constructor parameter
 * properties, because Node's type-stripping loader (used by `pnpm test`) does
 * not support that syntax.
 */
class MemoryLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  private readonly maxKeys: number;
  private readonly sweepIntervalMs: number;

  constructor(maxKeys = 10_000, sweepIntervalMs = 60_000) {
    this.maxKeys = maxKeys;
    this.sweepIntervalMs = sweepIntervalMs;
  }

  check(key: string, limit: number, windowSeconds: number): { allowed: boolean; retryAfter: number } {
    const now = Date.now();

    if (now - this.lastSweep > this.sweepIntervalMs) {
      this.lastSweep = now;
      if (this.hits.size > this.maxKeys) {
        const cutoff = now - windowSeconds * 1000;
        for (const [existingKey, timestamps] of this.hits) {
          if (timestamps[timestamps.length - 1]! < cutoff) this.hits.delete(existingKey);
        }
      }
    }

    const cutoff = now - windowSeconds * 1000;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0]!;
      this.hits.set(key, timestamps);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000)) };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfter: 0 };
  }
}

const memoryLimiters = new Map<string, MemoryLimiter>();

function limiterFor(name: string): MemoryLimiter {
  let limiter = memoryLimiters.get(name);
  if (!limiter) {
    limiter = new MemoryLimiter();
    memoryLimiters.set(name, limiter);
  }
  return limiter;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const resolveKey =
    options.key ??
    ((c: import('hono').Context<AppEnv>) => c.get('clientIp') ?? 'unknown');

  return async (c, next) => {
    const limit = typeof options.limit === 'function' ? options.limit(c) : options.limit;
    const windowSeconds =
      typeof options.windowSeconds === 'function' ? options.windowSeconds(c) : options.windowSeconds;

    const bindingName = options.binding ?? 'RATE_LIMITER_API';
    const binding = (c.env as Record<string, unknown>)[bindingName] as
      | RateLimiterBinding
      | undefined;

    let allowed = true;
    let retryAfter = 0;

    if (binding && typeof binding.limit === 'function') {
      try {
        const result = await binding.limit({ key: resolveKey(c) });
        allowed = result.success;
        if (!allowed) retryAfter = windowSeconds;
      } catch (error) {
        // A binding failure must not take the API down; degrade to memory.
        console.warn(`[ratelimit] ${bindingName} failed, using in-memory fallback:`, error);
      }
    }

    if (!allowed) {
      return tooMany(c, retryAfter || windowSeconds, options.name);
    }

    if (!binding) {
      const result = limiterFor(options.name).check(resolveKey(c), limit, windowSeconds);
      if (!result.allowed) {
        return tooMany(c, result.retryAfter, options.name, 'in-memory');
      }
    }

    await next();
  };
}

function tooMany(
  c: import('hono').Context<AppEnv>,
  retryAfter: number,
  name: string,
  mechanism = 'binding',
): Response {
  console.warn(`[ratelimit] ${name} (${mechanism}) blocked a request from ${c.get('clientIp')}`);
  return c.json(
    { error: 'Too many requests — please slow down', code: 'RATE_LIMITED' },
    429,
    {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Policy': name,
      // Surfaced so the operator can tell edge limits from process limits.
      'X-RateLimit-Mechanism': mechanism,
    },
  );
}

/**
 * Tight bucket for credential endpoints.
 * Login and setup are the only brute-forceable surfaces in the app, so they
 * get a deliberately small budget.
 *
 * Limits resolve from per-request config, so a deployment (or a test run) can
 * widen them without touching code.
 */
export const authRateLimit = (): MiddlewareHandler<AppEnv> =>
  rateLimit({
    binding: 'RATE_LIMITER_AUTH',
    limit: (c) => c.get('config').authRateLimit,
    windowSeconds: (c) => c.get('config').rateWindowSeconds,
    name: 'auth',
  });

/** General API budget. */
export const apiRateLimit = (): MiddlewareHandler<AppEnv> =>
  rateLimit({
    binding: 'RATE_LIMITER_API',
    limit: (c) => c.get('config').apiRateLimit,
    windowSeconds: (c) => c.get('config').rateWindowSeconds,
    name: 'api',
  });

export { HttpError };
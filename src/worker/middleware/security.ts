import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from './../config.ts';

/**
 * Security response headers.
 *
 * Applied to every response, including errors and static assets, because a
 * missing header on one route type is exactly how these get bypassed.
 *
 * CSP notes:
 *   - `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval`. The
 *     Vite production build emits only external module scripts, so there is no
 *     reason to open this up. Recharts/Leaflet both work under a strict policy.
 *   - `style-src 'unsafe-inline'` *is* required: CSP3 nonces do not apply to
 *     `style=""` attributes, and React components here set inline styles for
 *     chart series colours and marker positions. It is scoped to styles only.
 *   - Map tiles come from OpenStreetMap, hence the tile host allowances.
 */

/**
 * Raster tile source for the edge map.
 *
 * OpenStreetMap's standard layer only: it needs no API key, which matters for
 * a self-hosted, privacy-focused tool with no third-party account. The dark
 * appearance is a CSS filter in the frontend, not a different provider.
 *
 * An operator who wants their own tiles can add the host here.
 */
const TILE_HOSTS = ['https://*.tile.openstreetmap.org'];

export function securityHeaders(config: AppConfig): MiddlewareHandler {
  return async (c, next) => {
    // Only meaningful for the API layer; static assets are served by the
    // Workers asset handler before this runs.
    await next();

    const headers = c.res.headers;

    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('X-DNS-Prefetch-Control', 'off');

    // Admin tooling does not need camera, mic, geolocation or payment.
    headers.set(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    );

    headers.set('X-Powered-By', '');

    // HSTS: 2 years, preload-eligible. Only over HTTPS, and skipped in dev so
    // `http://localhost` keeps working without a warning.
    if (config.environment === 'production') {
      headers.set(
        'Strict-Transport-Security',
        'max-age=63072000; includeSubDomains; preload',
      );
    }

    headers.set(
      'Content-Security-Policy',
      buildCsp(config),
    );

    if (config.environment === 'production') {
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    }
  };
}

function buildCsp(config: AppConfig): string {
  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    // Required for inline `style` attributes; scripts stay strict.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${TILE_HOSTS.join(' ')}`,
    `connect-src 'self' ${TILE_HOSTS.join(' ')}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];

  if (config.environment === 'production') {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

/**
 * Applied to API responses only.
 * Keeps browser caches from holding authenticated JSON, and hides server
 * version fingerprints.
 */
export function apiHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set('Cache-Control', 'no-store, max-age=0');
    headers.delete('ETag');
    headers.delete('Last-Modified');
  };
}
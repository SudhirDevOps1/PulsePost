/**
 * SSRF guard for outbound health-check requests.
 *
 * A health monitor is, by design, a service the operator points at arbitrary
 * URLs. That is the whole product — and it is also a server-side request
 * forgery primitive if left unchecked, because the Worker runs inside
 * Cloudflare's network where the following are reachable:
 *
 *   - `http://169.254.169.254/` — the cloud metadata endpoint
 *   - `http://localhost:*` / `127.0.0.0/8` — anything bound to the host
 *   - `http://10.0.0.0/8`, `172.16/12`, `192.168/16` — private infrastructure
 *   - IPv6 equivalents, including `[::1]` and `fc00::/7`
 *
 * Defence in depth, in order:
 *   1. Scheme allowlist (http/https only). Enforced in Zod *and* here.
 *   2. No credentials in the URL.
 *   3. Host must not be a literal private/loopback/link-local address.
 *   4. Hostnames are resolved when a resolver is available, and the resolved
 *      IPs are checked too — this defeats `http://127.0.0.1.nip.io`.
 *   5. Redirects are followed manually with a hard cap, re-validating every
 *      hop and stripping `Authorization` when the host changes.
 *
 * Operators who *want* to monitor internal hosts (the common Docker case) can
 * opt out with `ALLOW_PRIVATE_TARGETS=true`.
 */

export interface SsrfPolicy {
  allowPrivateTargets: boolean;
  /** Hard cap on redirect hops. */
  maxRedirects: number;
  /** Response body bytes to read at all. */
  maxBodyBytes: number;
}

export const DEFAULT_POLICY: SsrfPolicy = {
  allowPrivateTargets: false,
  maxRedirects: 3,
  maxBodyBytes: 1_048_576,
};

export class SsrfError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Blocked request to a disallowed target: ${reason}`);
    this.name = 'SsrfError';
    this.reason = reason;
  }
}

// --- IP classification -------------------------------------------------------

/** IPv4 ranges that must never be reached from a monitor. */
function classifyIpv4(octets: [number, number, number, number]): string | null {
  const [a, b] = octets;

  if (a === 0) return 'unspecified / this-network';
  if (a === 10) return 'private 10.0.0.0/8';
  if (a === 127) return 'loopback 127.0.0.0/8';
  if (a === 169 && b === 254) return 'link-local / cloud metadata 169.254.0.0/16';
  if (a === 172 && b >= 16 && b <= 31) return 'private 172.16.0.0/12';
  if (a === 192 && b === 168) return 'private 192.168.0.0/16';
  if (a === 192 && b === 0) return 'IETF protocol assignments 192.0.0.0/24';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT 100.64.0.0/10';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking 198.18.0.0/15';
  if (a === 198 && b === 51 && octets[2] === 100) return 'documentation 198.51.100.0/24';
  if (a === 203 && b === 0 && octets[2] === 113) return 'documentation 203.0.113.0/24';
  if (a >= 224) return 'multicast / reserved';

  return null;
}

function classifyIpv6(host: string): string | null {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!address.includes(':')) return null;

  if (address === '::' || address === '::0') return 'unspecified';
  if (address === '::1') return 'loopback ::1';

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible (::127.0.0.1) forms.
  const mapped = address.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && (address.startsWith('::ffff:') || address.startsWith('::'))) {
    const parts = mapped[1]!.split('.').map(Number) as [number, number, number, number];
    const reason = classifyIpv4(parts);
    return reason ? `IPv4-mapped ${reason}` : null;
  }

  const first = address.split(':')[0] ?? '';
  const group = Number.parseInt(first || '0', 16);

  if ((group & 0xfe00) === 0xfc00) return 'unique local fc00::/7';
  if ((group & 0xffc0) === 0xfe80) return 'link-local fe80::/10';
  if ((group & 0xff00) === 0xff00) return 'multicast ff00::/8';

  return null;
}

/** Returns a reason string when the host is disallowed, otherwise null. */
export function classifyHost(host: string): string | null {
  const lowered = host.toLowerCase().replace(/^\[|\]$/g, '');

  // Named loopback aliases.
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) return 'localhost alias';
  if (lowered === 'metadata.google.internal') return 'cloud metadata hostname';
  // AWS/Azure instance metadata service names.
  if (lowered === 'instance-data' || lowered === 'instance-data.ec2.internal') {
    return 'cloud metadata hostname';
  }

  const ipv4 = lowered.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number) as [number, number, number, number];
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return 'malformed IPv4 address';
    return classifyIpv4(octets);
  }

  // Trailing-dot FQDN form ("localhost.").
  if (lowered.endsWith('.')) return classifyHost(lowered.slice(0, -1));

  if (lowered.includes(':')) return classifyIpv6(lowered);

  return null;
}

/** Validate a URL without fetching it. Used by both the checker and the API. */
export function validateUrl(rawUrl: string, policy: SsrfPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('not a valid absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`scheme ${url.protocol} is not allowed`);
  }

  if (url.username || url.password) {
    throw new SsrfError('credentials embedded in the URL');
  }

  if (!policy.allowPrivateTargets) {
    const reason = classifyHost(url.hostname);
    if (reason) throw new SsrfError(reason);
  }

  return url;
}

/**
 * Optional DNS resolution.
 *
 * In Workers there is no DNS API, so this is a no-op there and the literal-IP
 * check above carries the weight. In Node (Docker, tests) a resolver is
 * available, and resolving first closes the DNS-rebinding gap that a hostname
 * like `127.0.0.1.nip.io` would otherwise open.
 */
export type Resolver = (hostname: string) => Promise<string[]>;

export const nodeResolver: Resolver = async (hostname) => {
  const dns = await import('node:dns/promises');
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    // Resolution failure is left to `fetch`, which will surface a DNS error.
    return [];
  }
};

/** Validate a URL and, when a resolver is supplied, its resolved addresses. */
export async function assertAllowed(
  rawUrl: string,
  policy: SsrfPolicy,
  resolve?: Resolver,
): Promise<URL> {
  const url = validateUrl(rawUrl, policy);

  if (!policy.allowPrivateTargets && resolve && !isLiteralIp(url.hostname)) {
    const addresses = await resolve(url.hostname).catch(() => [] as string[]);
    for (const address of addresses) {
      const reason = classifyHost(address);
      if (reason) {
        throw new SsrfError(`${url.hostname} resolves to ${address} (${reason})`);
      }
    }
  }

  return url;
}

function isLiteralIp(host: string): boolean {
  const lowered = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(lowered) ||
    lowered.includes(':')
  );
}
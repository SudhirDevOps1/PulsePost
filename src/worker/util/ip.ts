/**
 * CIDR matching for the admin IP allowlist.
 *
 * Workers exposes `request.cf` with the connecting client IP. IPv4 and IPv6
 * both appear in real deployments, and a partial implementation (exact match
 * only) would silently fail *open* for anyone whose CIDR entry is not matched
 * — so the comparison is done against BigInt bitmasks rather than string
 * prefixes.
 */

/** Normalise an IP to a BigInt plus its bit width. */
export function parseIp(ip: string): { value: bigint; bits: number } | null {
  const version = ip.includes(':') ? 6 : 4;

  if (version === 4) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    let value = 0n;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const octet = Number(part);
      if (octet < 0 || octet > 255) return null;
      value = (value << 8n) | BigInt(octet);
    }
    return { value, bits: 32 };
  }

  // IPv6, including the `::` compressed form and IPv4-mapped tails.
  const [head, tail] = splitOnce(ip, '::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail !== null && tail ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - headParts.length - tailParts.length;

  const expand = (parts: string[]): string[] | null => {
    const out: string[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const octets = part.split('.');
        if (octets.length !== 4) return null;
        const high = ((Number(octets[0]) << 8) | Number(octets[1])).toString(16);
        const low = ((Number(octets[2]) << 8) | Number(octets[3])).toString(16);
        out.push(high, low);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        out.push(part.toLowerCase());
      } else {
        return null;
      }
    }
    return out;
  };

  const left = expand(headParts);
  const right = expand(tailParts);
  if (!left || !right) return null;

  const groups =
    tail === null
      ? (left.length === 8 ? left : null)
      : [...left, ...Array.from({ length: Math.max(0, fill) }, () => '0'), ...right];

  if (!groups || groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return { value, bits: 128 };
}

function splitOnce(value: string, separator: string): [string, string | null] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export interface IpRule {
  /** Base network address. */
  network: bigint;
  /** Prefix length in bits. */
  prefix: number;
  bits: number;
  raw: string;
}

/**
 * Parse an allowlist entry.
 * Accepts a bare IP (`203.0.113.7`), a CIDR range (`203.0.113.0/24`), and
 * `*` / `any` to disable the allowlist.
 */
export function parseRule(entry: string): IpRule | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  if (trimmed === '*' || trimmed.toLowerCase() === 'any') {
    return { network: 0n, prefix: 0, bits: 0, raw: '*' };
  }

  const slash = trimmed.indexOf('/');
  const addressPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const parsed = parseIp(addressPart);
  if (!parsed) return null;

  let prefix = parsed.bits;
  if (slash !== -1) {
    const value = Number(trimmed.slice(slash + 1));
    if (!Number.isInteger(value) || value < 0 || value > parsed.bits) return null;
    prefix = value;
  }

  // Zero out host bits so `10.0.0.5/24` and `10.0.0.0/24` behave the same.
  const hostMask = prefix === 0 ? 0n : ((1n << BigInt(parsed.bits - prefix)) - 1n);
  const network = parsed.value & ~hostMask;

  return { network, prefix, bits: parsed.bits, raw: trimmed };
}

export function parseAllowlist(entries: readonly string[]): IpRule[] {
  return entries.map(parseRule).filter((rule): rule is IpRule => rule !== null);
}

/** An empty allowlist means "no restriction" — fail open by design. */
export function isIpAllowed(allowlist: readonly IpRule[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;

  // A unix socket / local dev server has no client IP.
  if (ip === '::1' || ip === '127.0.0.1') {
    return allowlist.some(
      (rule) =>
        rule.bits === 0 ||
        (rule.bits === 32 && ip === '127.0.0.1') ||
        (rule.bits === 128 && rule.network === 0n),
    );
  }

  const parsed = parseIp(ip);
  if (!parsed) return false;

  return allowlist.some((rule) => {
    if (rule.bits === 0) return true; // `*`
    // An IPv4 address can never match an IPv6 rule, or vice versa.
    if (rule.bits !== parsed.bits) return false;

    if (rule.prefix === 0) return true;
    const shift = BigInt(parsed.bits - rule.prefix);
    return parsed.value >> shift === rule.network >> shift;
  });
}

/** Structural view of `request.cf`, avoiding a hard dependency on Workers types. */
export interface RequestCf {
  clientIp?: string;
  colo?: string;
  country?: string;
  city?: string;
  latitude?: string | number;
  longitude?: string | number;
  region?: string;
  regionCode?: string;
  asn?: number;
  timezone?: string;
}

/**
 * Best-effort client IP.
 *
 * Prefers Cloudflare's own `request.cf` value over the `CF-Connecting-IP`
 * header, because a header can be spoofed if the Worker is ever reached
 * directly rather than through Cloudflare's edge.
 */
export function clientIp(request: Request, cf?: RequestCf): string | undefined {
  if (cf && typeof cf.clientIp === 'string' && cf.clientIp) return cf.clientIp;
  const header = request.headers.get('CF-Connecting-IP');
  return header ?? undefined;
}
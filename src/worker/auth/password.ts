/**
 * Password hashing.
 *
 * The original Pingflare stores `SHA-256(password)` with no salt. That is
 * broken: identical passwords produce identical hashes, the whole table can be
 * rainbow-tabled from a single dump, and SHA-256 is far too fast to resist
 * offline guessing.
 *
 * We use PBKDF2-HMAC-SHA256 with a per-user random salt, at the iteration
 * count below. The stored format is versioned, so the cost can be raised later
 * without invalidating existing hashes.
 *
 * On the cost: OWASP's Password Storage Cheat Sheet lists PBKDF2-HMAC-SHA256
 * at 600,000 iterations as the floor today, which we would happily use, but
 * 100,000 is the **hard ceiling of the platform**. workerd's WebCrypto rejects
 * anything higher with
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000
 *   are not supported (requested 210000).
 *
 * Node's WebCrypto has no such cap, so this limit is invisible to `pnpm test`
 * and only shows up in production. That is exactly why the value lives in one
 * exported constant instead of being spelled out at each call site.
 */

const ALGORITHM = 'PBKDF2';
const HASH = 'SHA-256';

/**
 * The work factor used for newly created hashes.
 *
 * Keep this at or below 100,000 — the workerd PBKDF2 ceiling. Raise it only
 * after checking that Cloudflare has lifted the cap, because exceeding it makes
 * *every* signup and login throw rather than merely weaken them.
 *
 * Exported so timing-equalisation hashes (`DUMMY_HASH`) cannot drift away from
 * the real cost they are meant to imitate.
 */
export const ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

const PREFIX = 'pbkdf2';

export interface PasswordMeta {
  iterations: number;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Length-independent work factor: the digest is always the same size, but we
 * still hash the whole thing rather than bailing out on the first mismatch,
 * so the comparison time leaks nothing about where the bytes diverged.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i]! ^ b[i]!) as number;
  return diff === 0;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    ALGORITHM,
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: ALGORITHM,
      salt: salt as unknown as BufferSource,
      iterations,
      hash: HASH,
    },
    material,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a password.
 * @returns `pbkdf2$sha256$<iterations>$<salt-b64>$<hash-b64>`
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, ITERATIONS);
  return [
    PREFIX,
    HASH.toLowerCase(),
    String(ITERATIONS),
    toBase64(salt),
    toBase64(hash),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5) return false;

  const [prefix, hashName, iterationsRaw, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (prefix !== PREFIX || hashName !== HASH.toLowerCase()) return false;

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(saltB64);
    expected = fromBase64(hashB64);
  } catch {
    return false;
  }

  let actual: Uint8Array;
  try {
    actual = await derive(password, salt, iterations);
  } catch {
    // An unreadable hash must read as "wrong password", never as a 500. The
    // realistic cause is an iteration count above the platform ceiling, which
    // would otherwise turn every login into a server error.
    return false;
  }
  return constantTimeEqual(actual, expected);
}

/** True when a stored hash predates the current cost and should be upgraded. */
export function needsRehash(stored: string): boolean {
  const iterations = Number.parseInt(stored.split('$')[2] ?? '', 10);
  return !Number.isFinite(iterations) || iterations < ITERATIONS;
}

/** Number of PBKDF2 iterations a stored hash uses, for diagnostics. */
export function passwordMeta(stored: string): PasswordMeta {
  return { iterations: Number.parseInt(stored.split('$')[2] ?? '', 10) };
}

/** Cryptographically strong URL-safe token. */
export function randomToken(bytes = 32): string {
  const buffer = randomBytes(bytes);
  let out = '';
  for (const byte of buffer) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Fast one-way hash used to store session tokens at rest. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toBase64(new Uint8Array(digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * HMAC-SHA256, used for authenticating the cron endpoint.
 * A plain equality check on the secret would leak the secret byte-by-byte
 * through timing; HMAC comparison is constant time.
 */
export async function hmacEqual(secret: string, provided: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(provided));
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(secret));
  return constantTimeEqual(new Uint8Array(signature), new Uint8Array(expected));
}
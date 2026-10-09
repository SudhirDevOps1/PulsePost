/**
 * TOTP (RFC 6238) — optional second factor for the admin account.
 *
 * Deliberately implemented on WebCrypto rather than pulling in an OTP library:
 * it is ~80 lines, has no dependencies, and the algorithm is a fixed 30-step
 * HMAC construction we can audit directly.
 *
 * Compatibility defaults are SHA-1 / 6 digits / 30 s, which is what
 * Google Authenticator, Authy, 1Password and Aegis all expect. SHA-256 and
 * SHA-512 variants are also supported because the RFC allows them and some
 * enterprise authenticators use them.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;
const DEFAULT_WINDOW = 1; // accept one step either side to allow clock skew

type HashName = 'SHA-1' | 'SHA-256' | 'SHA-512';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

/** 20 random bytes — the RFC 4226 recommended shared-secret size. */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/** Build the `otpauth://` URI that authenticator apps consume as a QR code. */
export function otpauthUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
  hash?: HashName;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: (params.hash ?? 'SHA-1').replace('-', ''),
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

async function hotp(secretBytes: Uint8Array, counter: number, hash: HashName): Promise<string> {
  // 8-byte big-endian counter.
  const buffer = new Uint8Array(8);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes as unknown as BufferSource,
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );

  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer as unknown as BufferSource));

  // Dynamic truncation (RFC 4226 §5.4).
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface TotpVerifyResult {
  ok: boolean;
  /** Counter step that matched, so the caller can block replay of that code. */
  matchedStep?: number;
  reason?: string;
}

/**
 * Verify a submitted code.
 *
 * `lastUsedStep` provides replay protection: a 6-digit code is valid for up to
 * ~90 s across the window, so without this an attacker who shoulder-surfs a
 * code could reuse it inside the same window.
 */
export async function verifyTotp(
  secret: string,
  token: string,
  options: { lastUsedStep?: number; window?: number; hash?: HashName } = {},
): Promise<TotpVerifyResult> {
  const { window = DEFAULT_WINDOW, hash = 'SHA-1', lastUsedStep } = options;

  if (!/^\d{6}$/.test(token)) {
    return { ok: false, reason: 'Code must be exactly 6 digits' };
  }

  let secretBytes: Uint8Array;
  try {
    secretBytes = base32Decode(secret);
  } catch {
    return { ok: false, reason: 'Stored TOTP secret is malformed' };
  }
  if (secretBytes.length === 0) {
    return { ok: false, reason: 'Stored TOTP secret is empty' };
  }

  const currentStep = Math.floor(Date.now() / 1000 / PERIOD);

  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset;
    if (step < 0) continue;
    if (lastUsedStep !== undefined && step <= lastUsedStep) continue;

    const expected = await hotp(secretBytes, step, hash);
    if (expected === token) {
      return { ok: true, matchedStep: step };
    }
  }

  return { ok: false, reason: 'Invalid or expired code' };
}

/** Current step, for persisting the replay guard. */
export function currentTotpStep(): number {
  return Math.floor(Date.now() / 1000 / PERIOD);
}

/**
 * Derive the AES-GCM key that protects per-user TOTP secrets at rest.
 *
 * The passphrase comes from the `TOTP_SECRET` env var. There is deliberately
 * no default: a built-in fallback key would be public knowledge, which means a
 * leaked database row would decrypt straight to a live 2FA seed. Requiring the
 * operator to supply their own secret is the only version of this that is
 * actually worth having.
 *
 * SHA-256 stretches the passphrase to exactly 32 bytes, the AES-256 key length.
 * A KDF is overkill here — the input is a high-entropy operator-chosen secret,
 * not a human password — but it does normalise length and encoding, which
 * importKey requires.
 */
export async function deriveTotpEncryptionKey(passphrase: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(passphrase);
  const digest = await crypto.subtle.digest('SHA-256', material);

  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptTotpSecret(secret: string, passphrase: string): Promise<string> {
  const key = await deriveTotpEncryptionKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(secret),
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return base64Encode(combined);
}

export async function decryptTotpSecret(payload: string, passphrase: string): Promise<string> {
  const key = await deriveTotpEncryptionKey(passphrase);
  const combined = fromBase64(payload);
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

function base64Encode(bytes: Uint8Array): string {
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
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  ITERATIONS,
  hashPassword,
  needsRehash,
  passwordMeta,
  verifyPassword,
} from '../src/worker/auth/password.ts';

/**
 * Password hashing tests.
 *
 * The important one here is the iteration ceiling. Node's WebCrypto happily
 * derives at any iteration count, so the workerd limit is invisible to every
 * other test in this suite and only surfaces once the Worker is deployed — where
 * it broke signup and login outright:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000
 *   are not supported (requested 210000).
 *
 * The ceiling therefore has to be asserted as a plain constant, not inferred
 * from a call that happens to work on this runtime.
 */

/** workerd's PBKDF2 ceiling. Exceeding it throws rather than merely weakening. */
const PLATFORM_MAX_ITERATIONS = 100_000;

describe('password hashing', () => {
  test('stays within the platform iteration ceiling', () => {
    assert.ok(
      ITERATIONS <= PLATFORM_MAX_ITERATIONS,
      `ITERATIONS is ${ITERATIONS}, above the workerd ceiling of ${PLATFORM_MAX_ITERATIONS}. ` +
        'Signup and login will throw NotSupportedError in production.',
    );
  });

  test('the runtime can actually derive at the configured cost', async () => {
    // Proves the constant is not merely under the ceiling but genuinely
    // computable — a cost the runtime cannot afford is a failed login.
    const stored = await hashPassword('correct-horse-Battery9!');
    assert.equal(passwordMeta(stored).iterations, ITERATIONS);
    assert.ok(await verifyPassword('correct-horse-Battery9!', stored));
  });

  test('round-trips a password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct-horse-Battery9!');
    assert.ok(await verifyPassword('correct-horse-Battery9!', stored));
    assert.equal(await verifyPassword('correct-horse-Battery91', stored), false);
  });

  test('salts each hash, so identical passwords differ on disk', async () => {
    const a = await hashPassword('correct-horse-Battery9!');
    const b = await hashPassword('correct-horse-Battery9!');
    assert.notEqual(a, b, 'identical passwords must not produce identical hashes');
    assert.ok(await verifyPassword('correct-horse-Battery9!', a));
    assert.ok(await verifyPassword('correct-horse-Battery9!', b));
  });

  test('an unreadable stored hash reads as wrong, not as a server error', async () => {
    // Defensive: a hash whose cost exceeds what the runtime supports must not
    // turn every login into a 500.
    const overCeiling = `pbkdf2$sha256$${PLATFORM_MAX_ITERATIONS + 1}$AAAAAAAAAAAAAAAAAAAAAA==$AAAA`;
    assert.equal(await verifyPassword('anything', overCeiling), false);
  });

  test('malformed stored hashes are rejected rather than thrown on', async () => {
    for (const stored of ['', 'nope', 'pbkdf2$sha256$', 'md5$sha256$100000$AA$AA']) {
      assert.equal(await verifyPassword('anything', stored), false, stored);
    }
  });

  test('flags hashes below the current cost for upgrade', () => {
    assert.equal(needsRehash(`pbkdf2$sha256$${ITERATIONS - 1}$AA$AA`), true);
    assert.equal(needsRehash(`pbkdf2$sha256$${ITERATIONS}$AA$AA`), false);
    assert.equal(needsRehash(`pbkdf2$sha256$not-a-number$AA$AA`), true);
  });
});
import { zValidator } from '@hono/zod-validator';
import type { ZodSchema } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/context.ts';
import { fromZodError, isZodError } from './errors.ts';

/**
 * Zod validators that speak this app's error contract.
 *
 * `@hono/zod-validator`'s default behaviour is to *return*
 * `{ success: false, error: ZodError }` with its own 400 — not our envelope.
 * That breaks the uniform `{ error, code, details }` shape the frontend relies
 * on and dumps a raw Zod object into the response body.
 *
 * Supplying a `hook` that throws lets `app.onError` render the same envelope
 * for validation failures as for every other error, while still attaching
 * per-field `details` so the UI can highlight individual inputs.
 */
function throwingHook(result: unknown, _c: Context<AppEnv>): void {
  // `zValidator` only invokes the hook when validation failed, and hands the
  // failed result as the first argument.
  const error = (result as { error?: unknown } | undefined)?.error;
  if (isZodError(error)) {
    throw fromZodError(error);
  }
}

/** Validate a JSON body. */
export function validateJson<T extends ZodSchema>(schema: T) {
  return zValidator('json', schema, throwingHook as never);
}

/** Validate query-string parameters. */
export function validateQuery<T extends ZodSchema>(schema: T) {
  return zValidator('query', schema, throwingHook as never);
}

/** Validate path parameters. */
export function validateParam<T extends ZodSchema>(schema: T) {
  return zValidator('param', schema, throwingHook as never);
}
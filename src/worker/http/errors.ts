/**
 * Uniform API error shapes.
 *
 * Every failure path in the app throws an `HttpError`; `onError` renders it as
 * `{ error, code, details? }`. That keeps response bodies predictable for the
 * frontend and stops internal details from leaking in production while still
 * being debuggable in development.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, error: string, code?: string, details?: unknown) {
    super(error);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? defaultCode(status);
    this.details = details;
  }

  static badRequest(error: string, details?: unknown): HttpError {
    return new HttpError(400, error, 'BAD_REQUEST', details);
  }

  static unauthorized(error = 'Authentication required'): HttpError {
    return new HttpError(401, error, 'UNAUTHORIZED');
  }

  static forbidden(error = 'You do not have access to this resource'): HttpError {
    return new HttpError(403, error, 'FORBIDDEN');
  }

  static notFound(error = 'Not found'): HttpError {
    return new HttpError(404, error, 'NOT_FOUND');
  }

  static conflict(error: string): HttpError {
    return new HttpError(409, error, 'CONFLICT');
  }

  static tooManyRequests(error = 'Too many requests'): HttpError {
    return new HttpError(429, error, 'RATE_LIMITED');
  }

  static internal(error = 'Internal server error'): HttpError {
    return new HttpError(500, error, 'INTERNAL_ERROR');
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

export interface ErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

/** Structural view of a Zod issue, so this module need not import Zod. */
interface ZodIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
}

interface ZodLikeError extends Error {
  issues?: ZodIssue[];
  name: 'ZodError';
}

export function isZodError(error: unknown): error is ZodLikeError {
  return (
    error instanceof Error &&
    error.name === 'ZodError' &&
    Array.isArray((error as ZodLikeError).issues)
  );
}

/**
 * Turn a Zod failure into a flat, UI-friendly list of problems.
 *
 * `@hono/zod-validator` rethrows the raw `ZodError`, which would otherwise
 * surface as an opaque 500 and break the uniform error contract. Returning the
 * issue list is what lets the frontend highlight individual fields.
 */
export function fromZodError(error: ZodLikeError): HttpError {
  const issues = error.issues ?? [];
  return new HttpError(
    400,
    issues.length === 1 ? issues[0]!.message : `Validation failed on ${issues.length} fields`,
    'VALIDATION_ERROR',
    issues.map((issue) => ({
      field: issue.path.join('.') || '_',
      message: issue.message,
      code: issue.code,
    })),
  );
}

/**
 * Render an unknown thrown value into a safe JSON body.
 * Non-`HttpError` values are logged server-side and reduced to a generic 500.
 */
export function toErrorBody(
  error: unknown,
  isProduction: boolean,
): { status: number; body: ErrorBody } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        // Field-level validation detail is safe to return; it helps the UI
        // show a useful message.
        details: error.details,
      },
    };
  }

  // Validation failures are client errors, not server errors.
  if (isZodError(error)) {
    const httpError = fromZodError(error);
    return {
      status: httpError.status,
      body: { error: httpError.message, code: httpError.code, details: httpError.details },
    };
  }

  return {
    status: 500,
    body: {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: isProduction ? undefined : error instanceof Error ? error.message : String(error),
    },
  };
}
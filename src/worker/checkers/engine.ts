import type {
  Assertion,
  CheckOutcome,
  HttpMethod,
  Monitor,
  MonitorStatus,
  ScriptDSL,
  ScriptStep,
} from '../../shared/types.ts';
import { assertAllowed, DEFAULT_POLICY, type Resolver, type SsrfPolicy } from './ssrf.ts';

/**
 * The health-check engine.
 *
 * Two monitor kinds share one engine:
 *   - `http`: a single request with status/latency assertions.
 *   - `dsl`:  a chain of steps with variable extraction, so a check can model a
 *            real flow (login -> read token -> call an authenticated API).
 *
 * Design notes:
 *   - Redirects are followed manually so every hop is re-validated. A native
 *     `redirect: 'follow'` would happily walk straight into 169.254.169.254.
 *   - `Authorization` and `Cookie` are dropped when a redirect crosses hosts,
 *     because forwarding credentials to a different origin is how they leak.
 *   - Bodies are read through a size cap so a hostile endpoint cannot blow up
 *     Worker memory or the 10 ms CPU budget.
 *   - Latency thresholds can only *downgrade* a passing check to `degraded`;
 *     a failing assertion can still force `down`.
 */

export interface CheckContext {
  policy?: Partial<SsrfPolicy>;
  resolve?: Resolver;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  finalUrl: string;
  responseTimeMs: number;
  redirects: number;
}

/** The subset of a monitor the engine actually needs. */
export type CheckableMonitor = Pick<
  Monitor,
  | 'id'
  | 'kind'
  | 'url'
  | 'method'
  | 'headers'
  | 'body'
  | 'script'
  | 'timeout_ms'
  | 'retries'
  | 'max_response_bytes'
  | 'follow_redirects'
  | 'expected_status_min'
  | 'expected_status_max'
  | 'latency_warn_ms'
  | 'latency_fail_ms'
>;

export async function runCheck(
  monitor: CheckableMonitor,
  context: CheckContext = {},
): Promise<CheckOutcome> {
  const policy: SsrfPolicy = { ...DEFAULT_POLICY, ...context.policy };
  const doFetch = context.fetchImpl ?? fetch;
  const clock = context.now ?? (() => performance.now());

  const timeoutMs = Math.min(Math.max(monitor.timeout_ms || 10_000, 1000), 60_000);
  const maxBody = Math.min(monitor.max_response_bytes || policy.maxBodyBytes, 5_000_000);

  const options: EngineOptions = {
    policy,
    resolve: context.resolve,
    fetchImpl: doFetch,
    clock,
    timeoutMs,
    maxBody,
  };

  // Retry only transport-level failures (DNS, TCP, TLS, timeout, 5xx from the
  // edge). Retrying an assertion failure or a 500 from the target would double
  // the load on something already unhealthy and skew the latency number.
  const attempts = Math.min(Math.max(monitor.retries ?? 0, 0), 3) + 1;
  let lastTransportError: Error | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return monitor.kind === 'dsl' ? await runDsl(monitor, options) : await runHttp(monitor, options);
    } catch (error) {
      // A blocked target is a configuration problem, not a blip. Retrying it
      // would just burn subrequests, so it propagates immediately.
      if (error instanceof SsrfBlocked) throw error;

      if (error instanceof TransportError) {
        lastTransportError = error;
        continue;
      }

      // Anything unexpected is surfaced rather than retried.
      throw error;
    }
  }

  return {
    status: 'down',
    responseTimeMs: null,
    statusCode: null,
    errorMessage: lastTransportError
      ? lastTransportError.message
      : 'Check produced no result',
  };
}

/** Marker so a blocked target is never silently retried or downgraded. */
class SsrfBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlocked';
  }
}

/**
 * A failure below the application layer — DNS, TCP, TLS, timeout.
 * These are the only failures worth retrying.
 */
class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

interface EngineOptions {
  policy: SsrfPolicy;
  resolve: Resolver | undefined;
  fetchImpl: typeof fetch;
  clock: () => number;
  timeoutMs: number;
  maxBody: number;
}

// --- simple HTTP monitor -----------------------------------------------------

async function runHttp(monitor: CheckableMonitor, options: EngineOptions): Promise<CheckOutcome> {
  if (!monitor.url) {
    return {
      status: 'down',
      responseTimeMs: null,
      statusCode: null,
      errorMessage: 'No URL configured',
    };
  }

  const startedAt = options.clock();
  const headers = parseHeaders(monitor.headers);
  const method = (monitor.method ?? 'GET') as HttpMethod;

  let result: FetchResult;
  try {
    result = await executeRequest(
      {
        url: monitor.url,
        method,
        headers,
        body: monitor.body ?? undefined,
        followRedirects: monitor.follow_redirects !== false,
      },
      options,
    );
  } catch (error) {
    if (isSsrfError(error)) throw new SsrfBlocked(error.message);
    // Propagated so `runCheck` can retry it. The elapsed time is discarded
    // because a retried request's timing is not the monitor's real latency.
    throw new TransportError(describe(error));
  }

  const failures: string[] = [];

  const min = monitor.expected_status_min ?? 200;
  const max = monitor.expected_status_max ?? 299;
  if (result.status < min || result.status > max) {
    failures.push(`status ${result.status} is outside ${min}-${max}`);
  }

  if (result.redirects > 0 && monitor.follow_redirects === false) {
    failures.push(`followed ${result.redirects} redirect(s) while disabled`);
  }

  if (monitor.latency_fail_ms !== null && result.responseTimeMs > monitor.latency_fail_ms) {
    // Hard latency failure is `down`, not `degraded`.
    return {
      status: 'down',
      responseTimeMs: result.responseTimeMs,
      statusCode: result.status,
      errorMessage: `Response took ${result.responseTimeMs}ms, over the ${monitor.latency_fail_ms}ms limit`,
    };
  }

  let status: MonitorStatus = failures.length > 0 ? 'down' : 'up';

  if (
    status === 'up' &&
    monitor.latency_warn_ms !== null &&
    result.responseTimeMs > monitor.latency_warn_ms
  ) {
    status = 'degraded';
    failures.push(`slow: ${result.responseTimeMs}ms exceeds the ${monitor.latency_warn_ms}ms warning`);
  }

  return {
    status,
    responseTimeMs: result.responseTimeMs,
    statusCode: result.status,
    errorMessage: failures.length > 0 ? failures.join('; ') : null,
  };
}

// --- multi-step DSL ----------------------------------------------------------

async function runDsl(monitor: CheckableMonitor, options: EngineOptions): Promise<CheckOutcome> {
  if (!monitor.script) {
    return {
      status: 'down',
      responseTimeMs: null,
      statusCode: null,
      errorMessage: 'No script configured',
    };
  }

  let dsl: ScriptDSL;
  try {
    dsl = JSON.parse(monitor.script);
  } catch (error) {
    return {
      status: 'down',
      responseTimeMs: null,
      statusCode: null,
      errorMessage: `Script is not valid JSON: ${describe(error)}`,
    };
  }

  if (!Array.isArray(dsl.steps) || dsl.steps.length === 0) {
    return {
      status: 'down',
      responseTimeMs: null,
      statusCode: null,
      errorMessage: 'Script must contain a non-empty "steps" array',
    };
  }

  const startedAt = options.clock();
  const variables: Record<string, unknown> = {};
  const stepReports: NonNullable<CheckOutcome['steps']> = [];

  let hasDown = false;
  let hasDegraded = false;
  const failureMessages: string[] = [];
  let lastStatus: number | null = null;

  for (const step of dsl.steps) {
    let result: FetchResult;
    const stepStart = options.clock();

    try {
      result = await executeRequest(
        {
          url: interpolate(step.request.url, variables),
          method: step.request.method,
          headers: interpolateRecord(step.request.headers, variables),
          body: serializeBody(interpolateValue(step.request.body, variables)),
          followRedirects: true,
        },
        options,
      );
    } catch (error) {
      if (isSsrfError(error)) throw new SsrfBlocked(error.message);
      // A transport failure aborts the DSL (later steps would run on garbage
      // input) and is retried from the top by `runCheck`.
      throw new TransportError(`step "${step.name}": ${describe(error)}`);
    }

    lastStatus = result.status;
    const parsed = safeJson(result.body);

    const context = {
      status: result.status,
      body: result.body,
      json: parsed.value,
      headers: result.headers,
      responseTime: result.responseTimeMs,
    };

    let stepFailed = false;
    for (const assertion of step.assert ?? []) {
      const outcome = evaluateAssertion(assertion, context);
      if (outcome.passed) continue;

      stepFailed = true;
      const severity = assertion.severity ?? 'down';
      if (severity === 'down') hasDown = true;
      else hasDegraded = true;

      if (failureMessages.length < 5) {
        failureMessages.push(`step "${step.name}": ${outcome.message}`);
      }
    }

    stepReports.push({
      name: step.name,
      ok: !stepFailed,
      statusCode: result.status,
      responseTimeMs: result.responseTimeMs,
      error: stepFailed ? 'assertion failed' : null,
    });

    // Extract variables for subsequent steps.
    if (step.extract) {
      for (const [name, path] of Object.entries(step.extract)) {
        variables[name] = readPath(context, path);
      }
    }
  }

  const totalMs = Math.round(options.clock() - startedAt);
  const status: MonitorStatus = hasDown ? 'down' : hasDegraded ? 'degraded' : 'up';

  return {
    status,
    responseTimeMs: totalMs,
    statusCode: lastStatus,
    errorMessage: status === 'up' ? null : summarise(failureMessages),
    steps: stepReports,
  };
}

// --- request execution -------------------------------------------------------

interface RequestSpec {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string | undefined;
  followRedirects: boolean;
}

async function executeRequest(
  spec: RequestSpec,
  options: EngineOptions,
): Promise<FetchResult> {
  const maxRedirects = spec.followRedirects ? options.policy.maxRedirects : 0;
  const startedAt = options.clock();

  let currentUrl = spec.url;
  let currentHeaders = { ...spec.headers };
  let currentMethod = spec.method;
  let body = spec.body;
  let redirects = 0;

  for (;;) {
    // Every hop is re-validated — including after a redirect.
    const target = await assertAllowed(currentUrl, options.policy, options.resolve);

    // A controller is the only reliable way to bound fetch in Workers.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    let response: Response;
    try {
      response = await options.fetchImpl(target.toString(), {
        method: currentMethod,
        headers: currentHeaders,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (isRedirect(response.status) && redirects < maxRedirects) {
      const location = response.headers.get('location');
      if (location) {
        redirects += 1;
        const next = new URL(location, target);

        // Credentials must not follow a redirect off the original origin.
        if (next.origin !== target.origin) {
          currentHeaders = stripCredentials(currentHeaders);
        }

        currentUrl = next.toString();
        // 303, and 301/302 on POST, degrade to GET per RFC 9110.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          body = undefined;
          currentHeaders = stripEntityHeaders(currentHeaders);
        }
        continue;
      }
    }

    const text = await readCapped(response, options.maxBody);

    return {
      status: response.status,
      body: text.value,
      headers: collectHeaders(response),
      finalUrl: target.toString(),
      responseTimeMs: Math.round(options.clock() - startedAt),
      redirects,
    };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);

function stripCredentials(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function stripEntityHeaders(headers: Record<string, string>): Record<string, string> {
  const { 'content-type': _contentType, ...rest } = headers;
  return stripCredentials(rest);
}

/**
 * Read at most `limit` bytes of the body.
 * `arrayBuffer` on an unbounded response is how a Worker runs out of memory.
 */
async function readCapped(
  response: Response,
  limit: number,
): Promise<{ value: string; truncated: boolean }> {
  if (!response.body) return { value: '', truncated: false };

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    return { value: `(body ${declared} bytes exceeds the ${limit} byte limit)`, truncated: true };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      total += value.byteLength;

      if (total >= limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    const slice = chunk.subarray(0, merged.length - offset);
    merged.set(slice, offset);
    offset += slice.byteLength;
  }

  return { value: new TextDecoder().decode(merged), truncated: total > limit };
}

function collectHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

// --- assertions --------------------------------------------------------------

interface AssertionContext {
  status: number;
  body: string;
  json: unknown;
  headers: Record<string, string>;
  responseTime: number;
}

export function evaluateAssertion(
  assertion: Assertion,
  context: AssertionContext,
): { passed: boolean; message: string } {
  const actual = resolveValue(assertion.check, context);
  const label = assertion.check;

  const compare = (
    expected: unknown,
    pass: boolean,
    verb: string,
  ): { passed: boolean; message: string } => ({
    passed: pass,
    message: `${label} ${verb} ${format(expected)} (got ${format(actual)})`,
  });

  if ('equals' in assertion && assertion.equals !== undefined) {
    return compare(assertion.equals, looseEquals(actual, assertion.equals), 'should equal');
  }
  if ('notEquals' in assertion && assertion.notEquals !== undefined) {
    return compare(assertion.notEquals, !looseEquals(actual, assertion.notEquals), 'should not equal');
  }
  if ('greaterThan' in assertion && assertion.greaterThan !== undefined) {
    return compare(assertion.greaterThan, num(actual) > assertion.greaterThan, 'should be >');
  }
  if ('greaterThanOrEqual' in assertion && assertion.greaterThanOrEqual !== undefined) {
    return compare(
      assertion.greaterThanOrEqual,
      num(actual) >= assertion.greaterThanOrEqual,
      'should be >=',
    );
  }
  if ('lessThan' in assertion && assertion.lessThan !== undefined) {
    return compare(assertion.lessThan, num(actual) < assertion.lessThan, 'should be <');
  }
  if ('lessThanOrEqual' in assertion && assertion.lessThanOrEqual !== undefined) {
    return compare(assertion.lessThanOrEqual, num(actual) <= assertion.lessThanOrEqual, 'should be <=');
  }
  if ('contains' in assertion && assertion.contains !== undefined) {
    return compare(
      assertion.contains,
      String(actual ?? '').includes(assertion.contains),
      'should contain',
    );
  }
  if ('notContains' in assertion && assertion.notContains !== undefined) {
    return compare(
      assertion.notContains,
      !String(actual ?? '').includes(assertion.notContains),
      'should not contain',
    );
  }
  if ('matches' in assertion && assertion.matches !== undefined) {
    let pass = false;
    try {
      pass = new RegExp(assertion.matches, 'i').test(String(actual ?? ''));
    } catch {
      pass = false;
    }
    return compare(assertion.matches, pass, 'should match');
  }
  if ('exists' in assertion && assertion.exists !== undefined) {
    const present = actual !== undefined && actual !== null && actual !== '';
    return { passed: present === assertion.exists, message: `${label} existence` };
  }

  return {
    passed: false,
    message: `${label}: assertion has no recognised operator`,
  };
}

function resolveValue(path: string, context: AssertionContext): unknown {
  if (path === 'status') return context.status;
  if (path === 'responseTime' || path === 'responseTimeMs') return context.responseTime;
  if (path === 'body') return context.body;

  if (path.startsWith('header.')) {
    return context.headers[path.slice(7).toLowerCase()];
  }
  if (path.startsWith('json.')) {
    return readPath(context, path);
  }
  if (path === 'json') return context.json;

  return readPath(context, path);
}

/** Read a dot path out of the assertion context (`json.data.items.0.id`). */
function readPath(context: AssertionContext, path: string): unknown {
  const parts = path
    .replace(/^json\./, '')
    .split('.')
    .filter(Boolean);

  let current: unknown = context.json;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;

    const record = current as Record<string, unknown>;
    // Support both `items.0` and `items[0]`.
    const key = part.replace(/\[(\d+)\]$/, '$1');
    current = record[key];
  }
  return current;
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  // JSON numbers vs query-string numbers.
  if (typeof actual === 'number' && typeof expected === 'string') {
    return String(actual) === expected;
  }
  if (typeof actual === 'string' && typeof expected === 'number') {
    return actual === String(expected);
  }
  if (typeof actual === 'boolean' && typeof expected === 'string') {
    return String(actual) === expected;
  }
  return false;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function summarise(messages: string[]): string {
  if (messages.length === 0) return 'Check failed';
  const head = messages.slice(0, 3).join('; ');
  const rest = messages.length - 3;
  return rest > 0 ? `${head} (+${rest} more)` : head;
}

// --- helpers -----------------------------------------------------------------

function parseHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        out[key] = String(value);
      }
      return out;
    }
  } catch {
    // Fall through: treat it as a comma/colon list.
  }
  const out: Record<string, string> = {};
  for (const pair of raw.split(/[,\n]/)) {
    const separator = pair.indexOf(':');
    if (separator === -1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Replace `${var}` placeholders. Unknown variables are left as-is. */
function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (match, name: string) => {
    if (!(name in variables)) return match;
    const value = variables[name];
    return value === null || value === undefined ? '' : String(value);
  });
}

function interpolateRecord(
  headers: Record<string, string> | undefined,
  variables: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[interpolate(key, variables)] = interpolate(value, variables);
  }
  return out;
}

function interpolateValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') return interpolate(value, variables);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, variables));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[interpolate(key, variables)] = interpolateValue(item, variables);
    }
    return out;
  }
  return value;
}

function serializeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function safeJson(text: string): { value: unknown } {
  if (!text) return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: undefined };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // AbortError is what our own timeout produces; say so plainly.
    if (error.name === 'AbortError') return 'Request timed out';
    return error.message;
  }
  return String(error);
}

/** Type guard so `error.message` is reachable on the narrowed branch. */
function isSsrfError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'SsrfError' || error.message.startsWith('Blocked request to a disallowed target'))
  );
}

export type { ScriptStep };
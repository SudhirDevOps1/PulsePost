import { z } from 'zod';

/**
 * Every API input is validated here. Nothing reaches a database layer without
 * passing through one of these schemas first.
 */

// --- primitives -------------------------------------------------------------

export const httpMethodSchema = z.enum([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export const monitorStatusSchema = z.enum(['up', 'down', 'degraded']);
export const monitorKindSchema = z.enum(['http', 'dsl']);
export const userRoleSchema = z.enum(['admin', 'editor', 'viewer']);
export const incidentStatusSchema = z.enum(['investigating', 'identified', 'monitoring', 'resolved']);
export const incidentImpactSchema = z.enum(['none', 'minor', 'major', 'critical']);
export const channelTypeSchema = z.enum(['webhook', 'slack', 'discord']);

/**
 * A monitor target.
 *
 * `z.url()` alone is too permissive: it accepts `file://`, `gopher://`, and
 * credentials-in-URL, all of which the fetch engine must not be handed. The
 * scheme allowlist is enforced here so it can never be bypassed by a caller
 * that forgets to call the checker.
 */
const httpUrlSchema = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(2048, 'URL must be under 2048 characters')
  .url('Must be a valid URL')
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Only http:// and https:// URLs are allowed' },
  )
  .refine(
    (value) => {
      try {
        return !new URL(value).username && !new URL(value).password;
      } catch {
        return false;
      }
    },
    { message: 'Credentials in the URL are not allowed — use headers instead' },
  );

/** Header bag with a hard cap, since it is stored and replayed on every check. */
export const headersSchema = z
  .record(z.string().max(256), z.string().max(2048))
  .refine((value) => Object.keys(value).length <= 25, {
    message: 'At most 25 headers are allowed',
  });

const scriptSchema = z
  .string()
  .min(2)
  .max(20_000)
  .superRefine((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Script must be valid JSON' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as any).steps)) {
      ctx.addIssue({ code: 'custom', message: 'Script must be an object with a "steps" array' });
      return;
    }
    const steps = (parsed as { steps: unknown[] }).steps;
    if (steps.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Script needs at least one step' });
    }
    if (steps.length > 15) {
      ctx.addIssue({
        code: 'custom',
        message: 'At most 15 steps — each step costs a subrequest on the free tier',
      });
    }
  });

// --- monitors ---------------------------------------------------------------

const monitorFields = {
  name: z.string().trim().min(1, 'Name is required').max(120),
  kind: monitorKindSchema.default('http'),
  url: httpUrlSchema.nullish(),
  method: httpMethodSchema.default('GET'),
  headers: headersSchema.nullish(),
  body: z.string().max(64_000).nullish(),
  script: scriptSchema.nullish(),
  group_id: z.string().uuid().nullish(),
  interval_seconds: z.coerce.number().int().min(60).max(86_400).default(300),
  timeout_ms: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  retries: z.coerce.number().int().min(0).max(3).default(0),
  max_response_bytes: z.coerce.number().int().min(1024).max(5_000_000).default(1_048_576),
  follow_redirects: z.coerce.boolean().default(true),
  expected_status_min: z.coerce.number().int().min(100).max(599).nullish(),
  expected_status_max: z.coerce.number().int().min(100).max(599).nullish(),
  latency_warn_ms: z.coerce.number().int().min(1).max(600_000).nullish(),
  latency_fail_ms: z.coerce.number().int().min(1).max(600_000).nullish(),
  active: z.coerce.boolean().default(true),
};

/**
 * Cross-field rule: an HTTP monitor needs a URL, a DSL monitor needs a script,
 * and neither may be sent without its own payload.
 */
function refineMonitorShape(
  value: {
    kind?: string | undefined;
    url?: string | null | undefined;
    script?: string | null | undefined;
    expected_status_min?: number | null | undefined;
    expected_status_max?: number | null | undefined;
    latency_warn_ms?: number | null | undefined;
    latency_fail_ms?: number | null | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (value.kind === 'http' && !value.url) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL is required for an HTTP monitor' });
  }
  if (value.kind === 'dsl' && !value.script) {
    ctx.addIssue({
      code: 'custom',
      path: ['script'],
      message: 'Script is required for a DSL monitor',
    });
  }
  const min = value.expected_status_min;
  const max = value.expected_status_max;
  if (min != null && max != null && min > max) {
    ctx.addIssue({
      code: 'custom',
      path: ['expected_status_max'],
      message: 'expected_status_max must be >= expected_status_min',
    });
  }
  if (
    value.latency_warn_ms != null &&
    value.latency_fail_ms != null &&
    value.latency_warn_ms > value.latency_fail_ms
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['latency_fail_ms'],
      message: 'latency_fail_ms must be >= latency_warn_ms',
    });
  }
}

export const createMonitorSchema = z
  .object(monitorFields)
  .superRefine(refineMonitorShape)
  .strict();

export const updateMonitorSchema = z
  .object({
    name: monitorFields.name.optional(),
    kind: monitorKindSchema.optional(),
    url: httpUrlSchema.nullish(),
    method: httpMethodSchema.optional(),
    headers: headersSchema.nullish(),
    body: z.string().max(64_000).nullish(),
    script: scriptSchema.nullish(),
    // Must be `.nullish()`, not just `.nullable()`: a PATCH that omits
    // `group_id` means "leave it alone", which is different from "clear it".
    // `.nullable()` alone would make every partial update fail validation.
    group_id: z.string().uuid().nullish(),
    interval_seconds: z.coerce.number().int().min(60).max(86_400).optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(60_000).optional(),
    retries: z.coerce.number().int().min(0).max(3).optional(),
    max_response_bytes: z.coerce.number().int().min(1024).max(5_000_000).optional(),
    follow_redirects: z.coerce.boolean().optional(),
    expected_status_min: z.coerce.number().int().min(100).max(599).nullish(),
    expected_status_max: z.coerce.number().int().min(100).max(599).nullish(),
    latency_warn_ms: z.coerce.number().int().min(1).max(600_000).nullish(),
    latency_fail_ms: z.coerce.number().int().min(1).max(600_000).nullish(),
    active: z.coerce.boolean().optional(),
  })
  .strict();

const monitorSortKeySchema = z.enum(['name', 'created_at', 'updated_at']);

export const listMonitorsQuerySchema = z
  .object({
    group: z.string().uuid().optional(),
    status: monitorStatusSchema.optional(),
    active: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    // Case-insensitive substring match on name and URL.
    //
    // Capped at 48 because D1 rejects any `LIKE`/`GLOB` pattern over 50 bytes,
    // and the pattern wraps the term in two `%` wildcards. A longer term would
    // otherwise pass validation here and fail as a database error on the free
    // tier — the worst place for a user typing an unusual search to find out.
    q: z.string().trim().min(1).max(48).optional(),
    sort: monitorSortKeySchema.default('created_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
    // Adds a per-monitor 90-day uptime array. Useful for the dashboard list,
    // wasteful for pickers and anything else that only needs current status.
    include_uptime: z
      .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
      .transform((v) => v === 'true' || v === '1')
      .default(false),
  })
  .strict();

// --- groups -----------------------------------------------------------------

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes only')
  .nullish();

export const createGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: slugSchema,
    description: z.string().trim().max(500).nullish(),
    theme: z.string().trim().max(40).nullish(),
    is_public: z.coerce.boolean().default(false),
    display_order: z.coerce.number().int().min(0).max(9999).default(0),
  })
  .strict();

export const updateGroupSchema = createGroupSchema.partial().strict();

// --- incidents --------------------------------------------------------------

export const createIncidentSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    status: incidentStatusSchema.default('investigating'),
    impact: incidentImpactSchema.default('minor'),
    group_id: z.string().uuid().nullish(),
    message: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const updateIncidentSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    status: incidentStatusSchema.optional(),
    impact: incidentImpactSchema.optional(),
    // `.nullish()` not `.nullable()`: this is a PATCH, so an omitted key means
    // "leave the group alone". Bare `.nullable()` would make the field required
    // and force every caller to send it.
    group_id: z.string().uuid().nullish(),
    message: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

// --- notification channels --------------------------------------------------

export const createChannelSchema = z
  .object({
    type: channelTypeSchema,
    name: z.string().trim().min(1).max(120),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .url('Must be a valid URL')
      .refine((v) => {
        try {
          const p = new URL(v);
          return p.protocol === 'https:' || p.hostname === 'localhost';
        } catch {
          return false;
        }
      }, 'Webhook URLs must use https:// (http:// only allowed for localhost)')
      .refine((v) => {
        try {
          return !new URL(v).username && !new URL(v).password;
        } catch {
          return false;
        }
      }, 'Credentials in the URL are not allowed'),
  })
  .strict();

export const updateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: createChannelSchema.shape.url.optional(),
    active: z.coerce.boolean().optional(),
  })
  .strict();

export const linkChannelSchema = z
  .object({
    /**
     * The channel is identified by the path (`:id/link`), so this is optional
     * and ignored when present. It is still accepted because the field used to
     * be the only way to name a channel here, and existing clients may still
     * send it — dropping it outright would turn those calls into 400s.
     */
    channel_id: z.string().uuid().optional(),
    notify_on: z
      .string()
      .trim()
      .regex(/^(down|up|degraded)(,(down|up|degraded))*$/, 'Comma-separated subset of down,up,degraded')
      .default('down,up'),
    downtime_threshold_s: z.coerce.number().int().min(0).max(86_400).default(0),
  })
  .strict();

// --- auth -------------------------------------------------------------------

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
    password: z.string().min(1, 'Password is required').max(1024),
    /** Required only when the account has TOTP enabled. */
    totp_code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'TOTP code must be 6 digits')
      .optional(),
    remember: z.coerce.boolean().default(false),
  })
  .strict();

export const setupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
    password: z
      .string()
      .min(12, 'Use at least 12 characters')
      .max(1024)
      .refine((v) => /[a-z]/.test(v), 'Needs a lowercase letter')
      .refine((v) => /[A-Z]/.test(v), 'Needs an uppercase letter')
      .refine((v) => /\d/.test(v), 'Needs a number')
      .refine((v) => /[^A-Za-z0-9]/.test(v), 'Needs a symbol'),
    app_name: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1).max(1024),
    new_password: setupSchema.shape.password,
  })
  .strict();

export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
  })
  .strict();

export const createUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    password: setupSchema.shape.password,
    role: userRoleSchema.default('viewer'),
  })
  .strict();

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    role: userRoleSchema.optional(),
    disabled: z.coerce.boolean().optional(),
    password: setupSchema.shape.password.optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: z.string().uuid('Invalid id') }).strict();

export const slugParamSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug'),
  })
  .strict();

export const checkHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(2000).default(200),
    days: z.coerce.number().int().min(1).max(90).default(7),
  })
  .strict();

export const statusPageQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(365).default(90),
  })
  .strict();

/** Fire a check right now from the UI. */
export const manualCheckSchema = z.object({}).strict().default({});

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type LinkChannelInput = z.infer<typeof linkChannelSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
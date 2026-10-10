/**
 * Types shared by the Worker (server) and the React app (client).
 * Kept dependency-free so both bundles can import it safely.
 */

export type MonitorStatus = 'up' | 'down' | 'degraded';
export type MonitorKind = 'http' | 'dsl';
export type UserRole = 'admin' | 'editor' | 'viewer';
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';
/**
 * Notification transports.
 *
 * Derived from `CHANNEL_TYPES` in `schemas.ts` rather than restated, so the
 * type, the validation schema and the migration constraint cannot drift apart
 * without the compiler noticing.
 */
export type ChannelType = (typeof import('./schemas.ts').CHANNEL_TYPES)[number];

export interface Monitor {
  id: string;
  name: string;
  kind: MonitorKind;
  url: string | null;
  method: string;
  headers: string | null;
  body: string | null;
  script: string | null;
  group_id: string | null;
  interval_seconds: number;
  timeout_ms: number;
  retries: number;
  max_response_bytes: number;
  follow_redirects: boolean;
  expected_status_min: number | null;
  expected_status_max: number | null;
  latency_warn_ms: number | null;
  latency_fail_ms: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Check {
  id: string;
  monitor_id: string;
  status: MonitorStatus;
  response_time_ms: number | null;
  status_code: number | null;
  error_message: string | null;
  checked_at: string;
  checked_from: string | null;
  colo: string | null;
  region: string | null;
}

export interface DailyStatus {
  monitor_id: string;
  date: string;
  total_checks: number;
  up_checks: number;
  down_checks: number;
  degraded_checks: number;
  downtime_seconds: number;
  avg_response_time_ms: number | null;
  max_response_time_ms: number | null;
  p95_response_time_ms: number | null;
}

/** A monitor decorated with its live status, for dashboard rendering. */
export interface MonitorWithStatus extends Monitor {
  current_status: MonitorStatus | null;
  last_check: Check | null;
  uptime_24h: number | null;
  uptime_90d: number | null;
  avg_response_time_ms: number | null;
  /**
   * Recent response times, oldest first, for the dashboard sparkline.
   * Present only when the request asked for `include_latency`. Failed checks
   * are absent rather than zero, so the caller must tolerate gaps.
   */
  latency?: Array<number | null>;
}

export interface MonitorGroup {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  theme: string | null;
  is_public: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface Incident {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  group_id: string | null;
  auto_created: boolean;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  updates?: IncidentUpdate[];
}

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  status: IncidentStatus;
  message: string;
  created_at: string;
}

export interface NotificationChannel {
  id: string;
  type: ChannelType;
  name: string;
  /** Redacted on read; the raw URL/token never leaves the server. */
  config: string;
  active: boolean;
  created_at: string;
}

export interface MonitorNotification {
  monitor_id: string;
  channel_id: string;
  notify_on: string;
  downtime_threshold_s: number;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: string;
  last_login_at: string | null;
  totp_enabled: boolean;
}

/** Aggregate header for the dashboard. */
export interface Overview {
  total: number;
  up: number;
  down: number;
  degraded: number;
  paused: number;
  uptime_24h: number | null;
  uptime_90d: number | null;
  avg_response_time_ms: number | null;
  active_incidents: number;
  last_sweep_at: string | null;
  next_sweep_at: string | null;
}

/** One Cloudflare edge location a check was executed from. */
export interface EdgeNode {
  colo: string;
  city: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  status: MonitorStatus | null;
  avg_response_time_ms: number | null;
  checks_24h: number;
  last_checked_at: string | null;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

// --- health-check DSL -------------------------------------------------------

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type AssertOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'exists';

export interface Assertion {
  /** `status`, `responseTime`, `body`, `header.<name>`, `json.<path>` */
  check: string;
  equals?: unknown;
  notEquals?: unknown;
  greaterThan?: number;
  greaterThanOrEqual?: number;
  lessThan?: number;
  lessThanOrEqual?: number;
  contains?: string;
  notContains?: string;
  matches?: string;
  exists?: boolean;
  /** Which monitor status this failure should produce. */
  severity?: 'degraded' | 'down';
}

export interface ScriptStep {
  name: string;
  request: {
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  /** Map of variable name -> dot path (`json.token`, `status`, `body`). */
  extract?: Record<string, string>;
  assert?: Assertion[];
}

export interface ScriptDSL {
  steps: ScriptStep[];
}

export interface CheckOutcome {
  status: MonitorStatus;
  responseTimeMs: number | null;
  statusCode: number | null;
  errorMessage: string | null;
  /** Per-step breakdown, stored in the check log for the UI. */
  steps?: Array<{
    name: string;
    ok: boolean;
    statusCode: number | null;
    responseTimeMs: number | null;
    error: string | null;
  }>;
}
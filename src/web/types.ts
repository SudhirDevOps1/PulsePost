/** Client-side view types. Kept separate from `shared/types.ts` response shapes. */

export type MonitorStatus = 'up' | 'down' | 'degraded';
export type MonitorKind = 'http' | 'dsl';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  created_at: string;
  last_login_at: string | null;
  totp_enabled: boolean;
}

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

export interface MonitorWithStatus extends Monitor {
  current_status: MonitorStatus | null;
  last_check: Check | null;
  uptime_24h: number | null;
  uptime_90d: number | null;
  avg_response_time_ms: number | null;
  /** Present only when the request asked for `include_uptime`. */
  daily?: Array<{ date: string; uptime: number }>;
}

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

export interface CheckOutcome {
  status: MonitorStatus;
  responseTimeMs: number | null;
  statusCode: number | null;
  errorMessage: string | null;
  steps?: Array<{
    name: string;
    ok: boolean;
    statusCode: number | null;
    responseTimeMs: number | null;
    error: string | null;
  }>;
}

export interface PublicMonitor {
  id: string;
  name: string;
  status: MonitorStatus | null;
  uptime_24h: number | null;
  response_time_ms: number | null;
  checked_at: string | null;
  daily: Array<{ date: string; uptime: number }>;
}

export interface PublicGroup {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  theme: string | null;
  status: MonitorStatus;
  monitors: PublicMonitor[];
}

export interface PublicIncident {
  id: string;
  title: string;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  impact: 'none' | 'minor' | 'major' | 'critical';
  created_at: string;
  resolved_at: string | null;
  updates?: Array<{ id: string; status: string; message: string; created_at: string }>;
}

export interface PublicStatus {
  app_name: string;
  days: number;
  overall: MonitorStatus;
  groups: PublicGroup[];
  incidents: PublicIncident[];
  generated_at: string;
}

// --- incidents ---------------------------------------------------------------

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  status: IncidentStatus;
  message: string;
  created_at: string;
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

// --- notification channels ---------------------------------------------------

export type ChannelType = 'webhook' | 'slack' | 'discord';

/** One monitor→channel subscription as returned inside a channel. */
export interface ChannelMonitorLink {
  monitor_id: string;
  notify_on: string;
  downtime_threshold_s: number;
}

export interface NotificationChannel {
  id: string;
  type: ChannelType;
  name: string;
  /** Always `'***'` on read — the real URL is write-only by design. */
  config: string;
  active: boolean;
  created_at: string;
  /** Present only on the list endpoint, which joins the link table. */
  monitors?: ChannelMonitorLink[];
}

// --- audit -------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  user_id: string | null;
  action: string;
  target: string | null;
  meta: string | null;
  ip: string | null;
  ok: boolean;
  created_at: string;
}

// --- health ------------------------------------------------------------------

export interface HealthReport {
  ok: boolean;
  database: {
    provider: string;
    dialect: string;
    latency_ms: number;
    server_version: string;
  };
  version: string;
  environment: string;
  timestamp: string;
}
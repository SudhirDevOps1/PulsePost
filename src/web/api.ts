/**
 * Typed fetch wrapper for the API.
 *
 * The app and the API share an origin, so requests are same-origin and need no
 * CORS handling or preflight. Cookies are sent with `credentials: 'include'`
 * because auth is cookie-based.
 *
 * Every non-2xx response is normalised into an {@link ApiError} carrying the
 * server's `code` and any field-level `details`, so callers never have to
 * inspect raw responses.
 */

export interface FieldIssue {
  field: string;
  message: string;
  code?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, message: string, code: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level issues, when the failure was a validation error. */
  get issues(): FieldIssue[] {
    return Array.isArray(this.details) ? (this.details as FieldIssue[]) : [];
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

const BASE = '/api';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    // A network-level failure, DNS failure, or the Worker being unreachable.
    throw new ApiError(0, 'Could not reach the server. Check your connection.', 'NETWORK_ERROR');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(
      response.status,
      body.error ?? `Request failed with status ${response.status}`,
      body.code ?? 'ERROR',
      body.details,
    );
  }

  return payload as T;
}

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export const api = {
  // --- session ---
  authStatus: () =>
    request<{
      setup_complete: boolean;
      auth_mode: 'password' | 'basic' | 'totp';
      authenticated: boolean;
      user: import('./types.ts').SessionUser | null;
      app_name: string;
    }>('/auth/status'),

  setup: (input: {
    name: string;
    email: string;
    password: string;
    app_name?: string;
  }) => request<{ user: import('./types.ts').SessionUser }>('/auth/setup', {
    method: 'POST',
    body: JSON.stringify(input),
  }),

  login: (input: { email: string; password: string; totp_code?: string; remember?: boolean }) =>
    request<{ user?: import('./types.ts').SessionUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: import('./types.ts').SessionUser }>('/auth/me'),

  updateProfile: (input: { name?: string; email?: string }) =>
    request<{ user: import('./types.ts').SessionUser }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  changePassword: (input: { current_password: string; new_password: string }) =>
    request<{ ok: boolean }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // --- monitors ---
  monitors: (
    params: {
      group?: string;
      status?: string;
      active?: boolean;
      limit?: number;
      offset?: number;
      q?: string;
      sort?: 'name' | 'created_at' | 'updated_at';
      order?: 'asc' | 'desc';
      include_uptime?: boolean;
      include_latency?: boolean;
    } = {},
  ) =>
    request<{
      monitors: import('./types.ts').MonitorWithStatus[];
      limit: number;
      offset: number;
      has_more: boolean;
    }>(`/monitors${query(params)}`),

  overview: () => request<{ overview: import('./types.ts').Overview }>('/monitors/overview'),

  edge: () => request<{ nodes: import('./types.ts').EdgeNode[] }>('/monitors/edge'),

  monitorHistory: (id: string, params: { limit?: number; days?: number } = {}) =>
    request<{ checks: import('./types.ts').Check[]; daily: import('./types.ts').DailyStatus[] }>(
      `/monitors/${id}/checks${query(params)}`,
    ),

  createMonitor: (input: Record<string, unknown>) =>
    request<{ monitor: import('./types.ts').Monitor }>('/monitors', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateMonitor: (id: string, input: Record<string, unknown>) =>
    request<{ monitor: import('./types.ts').Monitor }>(`/monitors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteMonitor: (id: string) =>
    request<{ ok: boolean }>(`/monitors/${id}`, { method: 'DELETE' }),

  toggleMonitor: (id: string) =>
    request<{ monitor: import('./types.ts').Monitor }>(`/monitors/${id}/toggle`, { method: 'POST' }),

  runCheck: (id: string) =>
    request<{ result: import('./types.ts').CheckOutcome }>(`/monitors/${id}/check`, {
      method: 'POST',
    }),

  // --- groups (a group marked public is what /status publishes) ---
  groups: () => request<{ groups: import('./types.ts').MonitorGroup[] }>('/groups'),

  createGroup: (input: {
    name: string;
    slug?: string | null;
    description?: string | null;
    is_public?: boolean;
    display_order?: number;
  }) => request<{ group: import('./types.ts').MonitorGroup }>('/groups', {
    method: 'POST',
    body: JSON.stringify(input),
  }),

  updateGroup: (id: string, input: Record<string, unknown>) =>
    request<{ group: import('./types.ts').MonitorGroup }>(`/groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteGroup: (id: string) =>
    request<{ ok: boolean; orphaned_monitors: number }>(`/groups/${id}`, { method: 'DELETE' }),

  // --- incidents ---
  incidents: (params: { include_resolved?: boolean } = {}) =>
    request<{ incidents: import('./types.ts').Incident[] }>(`/incidents${query(params)}`),

  incident: (id: string) =>
    request<{ incident: import('./types.ts').Incident }>(`/incidents/${id}`),

  createIncident: (input: Record<string, unknown>) =>
    request<{ incident: import('./types.ts').Incident }>('/incidents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateIncident: (id: string, input: Record<string, unknown>) =>
    request<{ incident: import('./types.ts').Incident }>(`/incidents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteIncident: (id: string) =>
    request<{ ok: boolean }>(`/incidents/${id}`, { method: 'DELETE' }),

  // --- notification channels ---
  channels: () =>
    request<{ channels: import('./types.ts').NotificationChannel[] }>('/channels'),

  /**
   * Create a notification channel.
   *
   * The payload shape depends on the transport -- a URL for Slack, a bot token
   * and chat id for Telegram, a routing key for PagerDuty. The server is the
   * discriminator: it accepts each transport's own fields and rejects anything
   * else, so the client sends the flat object it was handed.
   */
  createChannel: (
    input: { type: string; name: string } & Record<string, string | undefined>,
  ) =>
    request<{ channel: import('./types.ts').NotificationChannel }>('/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateChannel: (id: string, input: Record<string, unknown>) =>
    request<{ channel: import('./types.ts').NotificationChannel }>(`/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteChannel: (id: string) => request<{ ok: boolean }>(`/channels/${id}`, { method: 'DELETE' }),

  /** Attaches (or updates) a channel→monitor subscription. */
  /**
 * Attach a channel to a monitor.
 *
 * The body carries `channel_id`, not `monitor_id`: the channel id is already
 * in the path, and the server's `linkChannelSchema` expects the channel. The
 * backend has always been shaped this way.
 */
  /**
 * Attach a channel to a monitor.
 *
 * `monitor_id` is a query parameter, not a body field — that is the only shape
 * the route accepts. The body carries the per-monitor policy only.
 */
  linkChannel: (
    id: string,
    input: { monitor_id: string; notify_on?: string; downtime_threshold_s?: number },
  ) =>
    request<{ ok: boolean }>(`/channels/${id}/link${query({ monitor_id: input.monitor_id })}`, {
      method: 'POST',
      body: JSON.stringify({
        channel_id: id,
        notify_on: input.notify_on ?? 'down,up',
        downtime_threshold_s: input.downtime_threshold_s ?? 0,
      }),
    }),

  unlinkChannel: (id: string, monitorId: string) =>
    request<{ ok: boolean }>(`/channels/${id}/link/${monitorId}`, { method: 'DELETE' }),

  testChannel: (id: string) =>
    request<{ ok: boolean; detail?: string }>(`/channels/${id}/test`, { method: 'POST' }),

  // --- users ---
  users: () => request<{ users: import('./types.ts').SessionUser[] }>('/users'),

  createUser: (input: { name: string; email: string; password: string; role: string }) =>
    request<{ user: import('./types.ts').SessionUser }>('/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateUser: (id: string, input: Record<string, unknown>) =>
    request<{ user: import('./types.ts').SessionUser }>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteUser: (id: string) => request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),

  startTotp: (id: string) =>
    request<{ secret: string; otpauth_uri: string }>(`/users/${id}/totp/start`, { method: 'POST' }),

  confirmTotp: (id: string, code: string) =>
    request<{ ok: boolean }>(`/users/${id}/totp/confirm`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  disableTotp: (id: string) =>
    request<{ ok: boolean }>(`/users/${id}/totp/disable`, { method: 'POST' }),

  // --- public status ---
  publicStatus: (days = 90) =>
    request<import('./types.ts').PublicStatus>(`/public/status${query({ days })}`),

  /** Per-group public page. Separate endpoint from the aggregate one. */
  publicGroupStatus: (slug: string, days = 90) =>
    request<import('./types.ts').PublicStatus>(`/public/status/${encodeURIComponent(slug)}${query({ days })}`),

  /** The only public endpoint that returns incident timeline updates. */
  publicIncidents: () =>
    request<{ incidents: import('./types.ts').PublicIncident[] }>('/public/incidents'),

  // --- health ---
  health: () => request<import('./types.ts').HealthReport>('/health'),
};
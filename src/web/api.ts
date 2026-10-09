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

  // --- monitors ---
  monitors: (params: { group?: string; status?: string; active?: boolean; limit?: number; include_uptime?: boolean } = {}) =>
    request<{ monitors: import('./types.ts').MonitorWithStatus[] }>(`/monitors${query(params)}`),

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

  // --- public status ---
  publicStatus: (days = 90) =>
    request<import('./types.ts').PublicStatus>(`/public/status${query({ days })}`),
};
-- ===========================================================================
--  pulsepost / 0001_init
--  PORTABLE SQL — must run unmodified on both SQLite (D1, Turso, local) and
--  PostgreSQL (Neon, Supabase, Hyperdrive).
--
--  Portability rules used throughout:
--    * TEXT primary keys, UUIDs generated in the application.
--    * All timestamps stored as ISO-8601 UTC strings in TEXT columns so that
--      lexicographic ordering equals chronological ordering on both engines.
--      `{{now}}` / `{{now_date}}` are placeholders the dialect layer rewrites
--      into the correct native expression per engine.
--    * No AUTOINCREMENT, no `datetime('now')`, no `INSERT OR REPLACE`.
--      Upserts use `ON CONFLICT ... DO UPDATE`, valid on both since SQLite 3.24.
--    * No `GROUP_CONCAT` / `string_agg` — aggregation that differs between
--      engines is done in TypeScript instead.
--    * BOOLEAN columns: the dialect layer binds 0/1 on SQLite and true/false
--      on PostgreSQL.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Migration bookkeeping (the adapter refuses to run without this table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT {{now}}
);

-- ---------------------------------------------------------------------------
-- Key/value app settings (onboarding state, instance config, defaults)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT {{now}}
);

-- ---------------------------------------------------------------------------
-- Users — PBKDF2-SHA256 hashes, optional TOTP
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin',
  totp_secret     TEXT,
  totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  disabled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TEXT NOT NULL DEFAULT {{now}},
  updated_at      TEXT NOT NULL DEFAULT {{now}},
  last_login_at   TEXT,
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'editor', 'viewer'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_disabled ON users (disabled);

-- ---------------------------------------------------------------------------
-- Sessions — only the SHA-256 of the token is stored, so a database leak
-- does not hand an attacker usable session cookies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT {{now}},
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT {{now}},
  ip           TEXT,
  user_agent   TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Monitor groups — double as public status-page definitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitor_groups (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT,
  description    TEXT,
  theme          TEXT,
  is_public      BOOLEAN NOT NULL DEFAULT FALSE,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT {{now}},
  updated_at     TEXT NOT NULL DEFAULT {{now}}
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug ON monitor_groups (slug);
CREATE INDEX IF NOT EXISTS idx_groups_order ON monitor_groups (display_order);

-- ---------------------------------------------------------------------------
-- Monitors
--   kind = 'http'  -> simple url/method/headers monitor (common case)
--   kind = 'dsl'   -> multi-step JSON script (login -> token -> authed call)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitors (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL DEFAULT 'http',
  url                  TEXT,
  method               TEXT NOT NULL DEFAULT 'GET',
  headers              TEXT,
  body                 TEXT,
  script               TEXT,
  group_id             TEXT,
  interval_seconds     INTEGER NOT NULL DEFAULT 60,
  timeout_ms           INTEGER NOT NULL DEFAULT 10000,
  retries              INTEGER NOT NULL DEFAULT 0,
  max_response_bytes   INTEGER NOT NULL DEFAULT 1048576,
  follow_redirects     BOOLEAN NOT NULL DEFAULT TRUE,
  expected_status_min  INTEGER,
  expected_status_max  INTEGER,
  latency_warn_ms      INTEGER,
  latency_fail_ms      INTEGER,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TEXT NOT NULL DEFAULT {{now}},
  updated_at           TEXT NOT NULL DEFAULT {{now}},
  FOREIGN KEY (group_id) REFERENCES monitor_groups (id) ON DELETE SET NULL,
  CONSTRAINT monitors_kind_check CHECK (kind IN ('http', 'dsl')),
  CONSTRAINT monitors_method_check CHECK (
    method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')
  ),
  -- A DSL monitor runs a script and needs no URL; an HTTP monitor is the
  -- reverse. Enforced here so a bug in the API layer cannot write a row that
  -- the check engine has no way to execute.
  CONSTRAINT monitors_payload_check CHECK (
    (kind = 'http' AND url IS NOT NULL) OR (kind = 'dsl' AND script IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_monitors_active ON monitors (active);
CREATE INDEX IF NOT EXISTS idx_monitors_group ON monitors (group_id);
CREATE INDEX IF NOT EXISTS idx_monitors_kind ON monitors (kind);

-- ---------------------------------------------------------------------------
-- Raw check history (short retention: RAW_CHECK_RETENTION_DAYS, default 7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checks (
  id               TEXT PRIMARY KEY,
  monitor_id       TEXT NOT NULL,
  status           TEXT NOT NULL,
  response_time_ms INTEGER,
  status_code      INTEGER,
  error_message    TEXT,
  checked_at       TEXT NOT NULL DEFAULT {{now}},
  checked_from     TEXT,
  colo             TEXT,
  region           TEXT,
  FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE,
  CONSTRAINT checks_status_check CHECK (status IN ('up', 'down', 'degraded'))
);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_time ON checks (monitor_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_checks_time ON checks (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_status ON checks (monitor_id, status, checked_at DESC);

-- ---------------------------------------------------------------------------
-- Daily rollups (long retention: DAILY_STATUS_RETENTION_DAYS, default 365)
-- Keeps 90/365-day uptime bars cheap: ~365 rows instead of ~525,600.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_status (
  monitor_id          TEXT NOT NULL,
  date                TEXT NOT NULL,
  total_checks        INTEGER NOT NULL DEFAULT 0,
  up_checks           INTEGER NOT NULL DEFAULT 0,
  down_checks         INTEGER NOT NULL DEFAULT 0,
  degraded_checks     INTEGER NOT NULL DEFAULT 0,
  downtime_seconds    INTEGER NOT NULL DEFAULT 0,
  avg_response_time_ms INTEGER,
  max_response_time_ms INTEGER,
  p95_response_time_ms INTEGER,
  PRIMARY KEY (monitor_id, date),
  FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_daily_status_date ON daily_status (date DESC);

-- ---------------------------------------------------------------------------
-- Incidents + timeline updates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'investigating',
  impact      TEXT NOT NULL DEFAULT 'minor',
  group_id    TEXT,
  auto_created BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TEXT NOT NULL DEFAULT {{now}},
  updated_at  TEXT NOT NULL DEFAULT {{now}},
  resolved_at TEXT,
  FOREIGN KEY (group_id) REFERENCES monitor_groups (id) ON DELETE SET NULL,
  CONSTRAINT incidents_status_check CHECK (
    status IN ('investigating', 'identified', 'monitoring', 'resolved')
  ),
  CONSTRAINT incidents_impact_check CHECK (impact IN ('none', 'minor', 'major', 'critical'))
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT {{now}},
  FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
  CONSTRAINT incident_updates_status_check CHECK (
    status IN ('investigating', 'identified', 'monitoring', 'resolved')
  )
);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates (incident_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Notification channels (webhook / slack / discord)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_channels (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TEXT NOT NULL DEFAULT {{now}},
  CONSTRAINT channels_type_check CHECK (type IN ('webhook', 'slack', 'discord'))
);
CREATE INDEX IF NOT EXISTS idx_channels_active ON notification_channels (active);

CREATE TABLE IF NOT EXISTS monitor_notifications (
  monitor_id            TEXT NOT NULL,
  channel_id            TEXT NOT NULL,
  notify_on             TEXT NOT NULL DEFAULT 'down,up',
  downtime_threshold_s  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, channel_id),
  FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES notification_channels (id) ON DELETE CASCADE,
  CONSTRAINT monitor_notifications_threshold_check CHECK (downtime_threshold_s >= 0)
);

-- ---------------------------------------------------------------------------
-- Alert state — drives deduplication and downtime-threshold logic so a
-- monitor that stays down for an hour does not spam 60 notifications.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_states (
  monitor_id           TEXT PRIMARY KEY,
  current_status       TEXT,
  previous_status      TEXT,
  down_since           TEXT,
  last_notified_status TEXT,
  last_notified_at     TEXT,
  notify_count         INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL DEFAULT {{now}},
  FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Audit trail for auth events and destructive operations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  meta        TEXT,
  ip          TEXT,
  ok          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TEXT NOT NULL DEFAULT {{now}}
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
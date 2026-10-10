-- ===========================================================================
--  pulsepost / 0002_widen_channel_types
--
--  Adds ten notification transports. Same portability rules as 0001: no
--  SQLite-only syntax, no engine-specific DDL.
--
--  WHY A TABLE REBUILD
--  ------------------
--  `notification_channels.type` carries a CHECK constraint listing the three
--  transports that existed when the table was created. SQLite cannot ALTER a
--  CHECK constraint -- the only portable way to change one is to recreate the
--  table and copy the rows across. That is what the standard twelve-step ALTER
--  procedure does, and it is written out longhand here because Workers has no
--  tooling that would do it.
--
--  The rebuild is safe to run against a populated database: rows are copied
--  before the old table is dropped, and the copy carries `created_at` so
--  channel ordering does not shift underneath anyone.
--
--  `foreign_keys` is toggled off for the copy because dropping the old
--  `notification_channels` table would otherwise fail while `monitor_notifications`
--  still references it. It is restored immediately afterwards, and the
--  adapter runs migrations inside its own transaction where the dialect
--  supports it.
-- ===========================================================================

PRAGMA foreign_keys = OFF;

-- --------------------------------------------------------------------------
-- Rebuild notification_channels with the widened constraint
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_channels_new (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TEXT NOT NULL DEFAULT {{now}},
  CONSTRAINT channels_type_check CHECK (type IN (
    'webhook',
    'slack',
    'discord',
    'telegram',
    'ntfy',
    'gotify',
    'pushover',
    'pushbullet',
    'pagerduty',
    'opsgenie',
    'stoat',
    'mattermost',
    'rocketchat'
  ))
);

INSERT INTO notification_channels_new (id, type, name, config, active, created_at)
SELECT id, type, name, config, active, created_at FROM notification_channels;

DROP TABLE notification_channels;

ALTER TABLE notification_channels_new RENAME TO notification_channels;

CREATE INDEX IF NOT EXISTS idx_channels_active ON notification_channels (active);

PRAGMA foreign_keys = ON;
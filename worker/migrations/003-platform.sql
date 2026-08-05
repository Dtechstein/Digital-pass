-- Migration 003: the platform — brands, creation API, scheduler, message log (2026-08-05)
-- Apply:
--   npx wrangler d1 execute digital-pass --remote --file=worker/migrations/003-platform.sql --config worker/wrangler.toml

CREATE TABLE IF NOT EXISTS brands (
  id            TEXT PRIMARY KEY,        -- slug, e.g. 'love'
  name          TEXT NOT NULL,           -- display / org name on cards
  api_key_hash  TEXT NOT NULL,           -- SHA-256 hex of the Bearer key (key itself never stored)
  template_json TEXT NOT NULL DEFAULT '{}', -- overrides: colors, logoText, barcodePrefix, albumUrl…
  created_at    INTEGER NOT NULL
);

ALTER TABLE passes ADD COLUMN brand_id TEXT;      -- NULL = legacy test cards (treated as 'love')
ALTER TABLE passes ADD COLUMN external_id TEXT;   -- caller's id; idempotency key per brand

CREATE UNIQUE INDEX IF NOT EXISTS idx_passes_brand_ext
  ON passes(brand_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS update_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  serial     TEXT NOT NULL,
  at         INTEGER NOT NULL,            -- unix seconds
  kind       TEXT NOT NULL,               -- created | updated | notified | scheduled_sent
  message    TEXT,                        -- notification text if any
  apple      TEXT,                        -- e.g. 'pushed:1' / 'pushed:0'
  google     TEXT                         -- e.g. 'updated+notified' / 'no_object'
);
CREATE INDEX IF NOT EXISTS idx_log_serial ON update_log(serial, at);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  serial   TEXT NOT NULL,
  send_at  INTEGER NOT NULL,              -- unix seconds
  message  TEXT NOT NULL,
  sent_at  INTEGER                        -- NULL = pending
);
CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_messages(sent_at, send_at);

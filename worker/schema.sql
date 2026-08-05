-- Digital Pass — D1 schema (step 2: pass storage + Apple device registrations)
-- Apply with:
--   npx wrangler d1 execute digital-pass --remote --file=worker/schema.sql --config worker/wrangler.toml

CREATE TABLE IF NOT EXISTS passes (
  serial      TEXT PRIMARY KEY,
  auth_token  TEXT NOT NULL,          -- per-pass ApplePass authentication token
  fields_json TEXT NOT NULL,          -- current field values (JSON)
  created_at  INTEGER NOT NULL,       -- unix seconds
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER                 -- NULL = active; set = archived (never destroyed)
);

CREATE TABLE IF NOT EXISTS apple_registrations (
  device_id   TEXT NOT NULL,          -- deviceLibraryIdentifier
  serial      TEXT NOT NULL,
  push_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, serial)
);

CREATE INDEX IF NOT EXISTS idx_reg_serial ON apple_registrations(serial);

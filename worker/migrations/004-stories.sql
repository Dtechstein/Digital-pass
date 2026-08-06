-- Migration 004: act completion + stories, consent-gated forever (2026-08-06)
-- Apply to existing databases:
--   npx wrangler d1 execute digital-pass --remote --file=worker/migrations/004-stories.sql --config worker/wrangler.toml
CREATE TABLE IF NOT EXISTS act_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL,             -- which card completed
  story TEXT,                       -- their words (may be empty — completion without story)
  photo_url TEXT,                   -- act photo (v2 — needs R2)
  consent INTEGER NOT NULL DEFAULT 0,        -- 1 ONLY if they explicitly said yes
  consented_at INTEGER,             -- when they said yes (NULL if no consent)
  act_number INTEGER,               -- their # in the movement, stamped at completion
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stories_serial ON act_stories(serial); -- once per card (v1)

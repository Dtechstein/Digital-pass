-- Migration 002: archive-don't-delete retention model (2026-08-05)
-- Apply to existing databases:
--   npx wrangler d1 execute digital-pass --remote --file=worker/migrations/002-archive.sql --config worker/wrangler.toml
ALTER TABLE passes ADD COLUMN archived_at INTEGER;

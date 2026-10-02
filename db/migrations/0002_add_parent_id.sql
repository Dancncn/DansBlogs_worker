-- Migration: v2 - Add parent_id for comment replies
-- LEGACY UPGRADE ONLY: first inspect PRAGMA table_info(comments).
-- Run this once only if parent_id is absent. Fresh databases initialized from
-- db/schema.sql already have this column and index; do not run this migration.
ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);

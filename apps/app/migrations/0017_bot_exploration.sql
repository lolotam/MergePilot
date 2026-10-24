-- Per-bot read-only repository exploration (ADR-0046); existing bots stay off.
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS explore_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE reviewer_bots ADD COLUMN IF NOT EXISTS explore_enabled boolean NOT NULL DEFAULT false;

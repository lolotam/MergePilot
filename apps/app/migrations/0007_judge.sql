-- 0007_judge.sql
-- The Jev judge (ADR-0015): an optional "System One" decision model that filters false positives
-- and checks semantic duplicates. Off for every workspace until an admin turns it on.
-- `judge_fallback` is an ordered list of up to three `{provider, model}` entries (validated by the
-- API against the fixed Jev-only model table), tried in order when the judge before them fails.

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS judge_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS judge_provider text NULL,
  ADD COLUMN IF NOT EXISTS judge_model text NULL,
  ADD COLUMN IF NOT EXISTS judge_mode text NOT NULL DEFAULT 'off'
    CHECK (judge_mode IN ('off', 'annotate', 'filter')),
  ADD COLUMN IF NOT EXISTS judge_threshold numeric(4, 3) NOT NULL DEFAULT 0.35
    CHECK (judge_threshold >= 0 AND judge_threshold <= 1),
  ADD COLUMN IF NOT EXISTS judge_fallback jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (CASE WHEN jsonb_typeof(judge_fallback) = 'array' THEN jsonb_array_length(judge_fallback) <= 3 ELSE false END);

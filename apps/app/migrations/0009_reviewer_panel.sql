-- 0009_reviewer_panel.sql
-- The reviewer panel (ADR-0017): up to five review bots per workspace. Slot 1 is the main bot,
-- configured by today's workspace settings (plus a name and a logo shown inside the review
-- comment); slots 2-5 are extra bots stored in `reviewer_bots`. Every bot gets its own review run,
-- so the one-active-run-per-head rule of 0004 becomes one active run per head and bot slot.
-- The migration runner applies this file in one transaction.

-- Extra bots (slots 2-5). `fallback` is an ordered list of up to three `{provider, model, effort}`
-- entries, validated by the API with the same rules as the main bot's fallback. Extra bots have no
-- heavy model. Names are unique per workspace, ignoring case (the API also checks the main bot).
CREATE TABLE IF NOT EXISTS reviewer_bots (
  workspace_id text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  slot smallint NOT NULL CHECK (slot BETWEEN 2 AND 5),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  logo text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  provider text NOT NULL,
  model text NOT NULL,
  effort text NULL,
  fallback jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (CASE WHEN jsonb_typeof(fallback) = 'array' THEN jsonb_array_length(fallback) <= 3 ELSE false END),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, slot)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviewer_bots_workspace_name
  ON reviewer_bots (workspace_id, lower(name));

-- The main bot's identity, and how the panel publishes: `separate` reviews per bot, or one
-- `consensus` review keeping findings that at least `panel_min_agreement` bots found.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS bot_name text NOT NULL DEFAULT 'MergePilot'
    CHECK (char_length(bot_name) BETWEEN 1 AND 40),
  ADD COLUMN IF NOT EXISTS bot_logo text NOT NULL DEFAULT 'pilot',
  ADD COLUMN IF NOT EXISTS panel_mode text NOT NULL DEFAULT 'separate'
    CHECK (panel_mode IN ('separate', 'consensus')),
  ADD COLUMN IF NOT EXISTS panel_min_agreement smallint NOT NULL DEFAULT 1
    CHECK (panel_min_agreement BETWEEN 1 AND 5);

-- Which bot a run belongs to; existing runs are the main bot's. `bot_name` is a snapshot.
ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS bot_slot smallint NOT NULL DEFAULT 1
    CHECK (bot_slot BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS bot_name text NULL;

-- One job runs every bot of the panel, so a retry reuses only its own bot's run of that job
-- (0003 allowed one reusable run per job).
DROP INDEX IF EXISTS idx_review_runs_workspace_job_id_active;
CREATE UNIQUE INDEX idx_review_runs_workspace_job_id_active
  ON review_runs (workspace_id, job_id, bot_slot)
  WHERE job_id IS NOT NULL AND status IN ('queued', 'running', 'failed');

-- One queued/running run per workspace, repo, PR, head commit and bot slot.
DROP INDEX IF EXISTS idx_review_runs_active_pr_head;
CREATE UNIQUE INDEX idx_review_runs_active_pr_head
  ON review_runs (workspace_id, repo_full_name, pull_number, head_sha, bot_slot)
  WHERE status IN ('queued', 'running');

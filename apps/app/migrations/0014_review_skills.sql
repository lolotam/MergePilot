-- 0014_review_skills.sql
-- Review skills (ADR-0034): Markdown instructions a workspace admin uploads, one chosen per bot,
-- added as the last section of that bot's review system prompt. NULL skill_id is "Default" (the
-- core prompt only), so every existing bot reviews exactly as before.
-- The migration runner applies this file in one transaction.

-- `ON DELETE SET NULL (skill_id)` below needs PostgreSQL 15 or later (we deploy 17): fail early
-- with a clear message instead of a syntax error halfway through.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'migration 0014_review_skills needs PostgreSQL 15 or later (found %)', current_setting('server_version');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS review_skills (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  content text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  size_tokens integer NOT NULL CHECK (size_tokens BETWEEN 1 AND 8000),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The target of the composite foreign keys below: a bot can only use its own workspace's skill.
  UNIQUE (workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_skills_workspace_name
  ON review_skills (workspace_id, lower(name));

-- The skill of the main bot (slot 1) and of each extra bot (slots 2-5). Deleting a skill sets
-- skill_id to NULL and keeps workspace_id (PostgreSQL 15+ column list); the API also records the
-- deleted skill's name in skill_removed_name, shown on the bot until a skill is chosen again.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS skill_id uuid NULL,
  ADD COLUMN IF NOT EXISTS skill_removed_name text NULL;
ALTER TABLE workspace_settings
  DROP CONSTRAINT IF EXISTS workspace_settings_skill_fk;
ALTER TABLE workspace_settings
  ADD CONSTRAINT workspace_settings_skill_fk FOREIGN KEY (workspace_id, skill_id)
    REFERENCES review_skills (workspace_id, id) ON DELETE SET NULL (skill_id);

ALTER TABLE reviewer_bots
  ADD COLUMN IF NOT EXISTS skill_id uuid NULL,
  ADD COLUMN IF NOT EXISTS skill_removed_name text NULL;
ALTER TABLE reviewer_bots
  DROP CONSTRAINT IF EXISTS reviewer_bots_skill_fk;
ALTER TABLE reviewer_bots
  ADD CONSTRAINT reviewer_bots_skill_fk FOREIGN KEY (workspace_id, skill_id)
    REFERENCES review_skills (workspace_id, id) ON DELETE SET NULL (skill_id);

-- The skill a run reviewed with, by name, kept like bot_name after a rename or delete.
ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS skill_name text NULL;

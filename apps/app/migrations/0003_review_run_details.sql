-- 0003_review_run_details.sql
-- Add detailed review run metadata, provider info, model details, result payload and indexes

ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS job_id text,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS effort text,
  ADD COLUMN IF NOT EXISTS fallback_from text,
  ADD COLUMN IF NOT EXISTS findings_count integer,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS review_url text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_runs_workspace_job_id
  ON review_runs (workspace_id, job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_runs_workspace_repo
  ON review_runs (workspace_id, repo_full_name);

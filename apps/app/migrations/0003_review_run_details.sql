-- 0003_review_run_details.sql
-- Add detailed review run metadata, provider info, model details, result payload, a heartbeat
-- column for the stale-run sweep, and indexes.

ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS job_id text,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS effort text,
  ADD COLUMN IF NOT EXISTS fallback_from text,
  ADD COLUMN IF NOT EXISTS findings_count integer,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS review_url text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Heartbeat: set on create, on every status change, and every ~60 s by the worker while a review
-- is in progress. The stale-run sweep fails queued/running runs with no heartbeat for 15 minutes.
UPDATE review_runs SET updated_at = coalesce(finished_at, created_at) WHERE updated_at IS NULL;
ALTER TABLE review_runs ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE review_runs ALTER COLUMN updated_at SET NOT NULL;

-- One reusable (queued/running/failed) run per job; completed and skipped runs are never reused,
-- so a later run of the same job gets its own row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_runs_workspace_job_id_active
  ON review_runs (workspace_id, job_id)
  WHERE job_id IS NOT NULL AND status IN ('queued', 'running', 'failed');

CREATE INDEX IF NOT EXISTS idx_review_runs_active_updated_at
  ON review_runs (updated_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_review_runs_workspace_repo
  ON review_runs (workspace_id, repo_full_name);

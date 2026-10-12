-- 0004_active_run_unique.sql
-- At most one queued/running review run per workspace, repo, PR and head commit (ADR-0009
-- amendment). The check "is a run for this head already active?" and the insert become one atomic
-- step: a second insert (or a reuse that would make a second active run) fails with a unique
-- violation, which the store surfaces as ActiveRunExistsError.

-- Older duplicates (created before this index existed) would block the index. Keep the newest
-- active run per head and close the rest as failed duplicates.
UPDATE review_runs
SET status = 'failed', detail = 'duplicate', finished_at = now(), updated_at = now()
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY workspace_id, repo_full_name, pull_number, head_sha
        ORDER BY created_at DESC, id DESC
      ) AS rn
    FROM review_runs
    WHERE status IN ('queued', 'running')
  ) ranked
  WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_runs_active_pr_head
  ON review_runs (workspace_id, repo_full_name, pull_number, head_sha)
  WHERE status IN ('queued', 'running');

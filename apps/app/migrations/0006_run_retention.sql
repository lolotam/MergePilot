-- 0006_run_retention.sql
-- Run retention (ADR-0014): a per-workspace retention period for review runs, a monthly usage
-- summary that keeps budgets and costs correct after runs are deleted, and a log of maintenance
-- jobs (the daily retention cleanup).

-- NULL = keep forever. The default (30 days) applies to new rows and fills existing workspaces.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS run_retention_days integer NULL DEFAULT 30
    CHECK (run_retention_days IS NULL OR run_retention_days > 0);

-- One row per workspace and UTC month (month = first day of the month the run was created in).
-- Every finished run (completed / failed / skipped) is added here in the same transaction that
-- finishes it; deleting runs never changes these rows.
CREATE TABLE IF NOT EXISTS workspace_usage_monthly (
  workspace_id text NOT NULL,
  month date NOT NULL,
  runs_total integer NOT NULL DEFAULT 0,
  runs_completed integer NOT NULL DEFAULT 0,
  runs_failed integer NOT NULL DEFAULT 0,
  cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, month)
);

-- Backfill from the runs that exist today. ON CONFLICT DO NOTHING keeps this safe to re-run:
-- a month that already has a summary row is left as it is.
INSERT INTO workspace_usage_monthly (
  workspace_id, month, runs_total, runs_completed, runs_failed, cost_usd, input_tokens, output_tokens
)
SELECT
  workspace_id,
  (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date AS month,
  count(*),
  count(*) FILTER (WHERE status = 'completed'),
  count(*) FILTER (WHERE status = 'failed'),
  coalesce(sum(cost_usd), 0),
  coalesce(sum(
    CASE WHEN jsonb_typeof(result -> 'usage' -> 'inputTokens') = 'number'
      THEN (result -> 'usage' ->> 'inputTokens')::numeric ELSE 0 END
  ), 0)::bigint,
  coalesce(sum(
    CASE WHEN jsonb_typeof(result -> 'usage' -> 'outputTokens') = 'number'
      THEN (result -> 'usage' ->> 'outputTokens')::numeric ELSE 0 END
  ), 0)::bigint
FROM review_runs
WHERE status IN ('completed', 'failed', 'skipped')
GROUP BY workspace_id, (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date
ON CONFLICT (workspace_id, month) DO NOTHING;

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  deleted_count integer NOT NULL DEFAULT 0,
  error text NULL
);

-- The job lease: at most one unfinished run per kind, so two workers (or the scheduled job and a
-- manual "run now") never clean up at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_runs_one_active
  ON maintenance_runs (kind)
  WHERE finished_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_kind_started_at
  ON maintenance_runs (kind, started_at DESC);

-- Per-repository colors for the runs table: `owner/repo` -> palette key (validated by the API).
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS repo_colors jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  id bigint PRIMARY KEY,
  workspace_id text NULL,
  account_login text NOT NULL,
  account_type text NOT NULL,
  repository_selection text NOT NULL,
  suspended boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  language text NOT NULL,
  monthly_budget_usd numeric(12, 4) NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  provider text NOT NULL,
  ciphertext text NOT NULL,
  key_version int NOT NULL,
  last4 text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_credentials_workspace_provider_key UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS review_runs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  installation_id bigint NOT NULL,
  repo_full_name text NOT NULL,
  pull_number int NOT NULL,
  head_sha text NOT NULL,
  status text NOT NULL,
  cost_usd numeric(12, 6) NULL,
  detail text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_installations_workspace_id ON installations (workspace_id);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_workspace_id ON provider_credentials (workspace_id);
CREATE INDEX IF NOT EXISTS idx_review_runs_workspace_id ON review_runs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_review_runs_workspace_created_at_desc ON review_runs (workspace_id, created_at DESC);

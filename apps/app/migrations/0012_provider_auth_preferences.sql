-- ADR-0027: default auth method per dual-method provider (anthropic, openai, xai).
CREATE TABLE IF NOT EXISTS provider_auth_preferences (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  default_method TEXT NOT NULL CHECK (default_method IN ('subscription', 'api-key')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider)
);

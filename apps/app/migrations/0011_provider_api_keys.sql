-- Ordered API keys for gemini, openrouter and opencode-zen (ADR-0026).
-- Each ciphertext uses the same vault envelope as provider_credentials.
-- An existing single key becomes position 0. Re-running this file adds nothing.

CREATE TABLE IF NOT EXISTS provider_api_keys (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  provider text NOT NULL,
  position integer NOT NULL,
  ciphertext text NOT NULL,
  key_version integer NOT NULL,
  last4 text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_test_status text NULL,
  last_tested_at timestamptz NULL,
  CONSTRAINT provider_api_keys_workspace_provider_position UNIQUE (workspace_id, provider, position),
  CONSTRAINT provider_api_keys_position_range CHECK (position >= 0 AND position < 20),
  CONSTRAINT provider_api_keys_status CHECK (
    last_test_status IS NULL OR last_test_status IN ('valid', 'invalid', 'quota-exhausted')
  )
);

CREATE INDEX IF NOT EXISTS idx_provider_api_keys_workspace_provider
  ON provider_api_keys (workspace_id, provider, position);

CREATE TABLE IF NOT EXISTS provider_key_cursors (
  workspace_id text NOT NULL,
  provider text NOT NULL,
  position integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider),
  CONSTRAINT provider_key_cursors_position_range CHECK (position >= 0 AND position < 20)
);

INSERT INTO provider_api_keys (
  id, workspace_id, provider, position, ciphertext, key_version, last4, created_by, created_at
)
SELECT id, workspace_id, provider, 0, ciphertext, key_version, last4, created_by, created_at
FROM provider_credentials
WHERE provider IN ('gemini', 'openrouter', 'opencode-zen')
  AND NOT EXISTS (
    SELECT 1 FROM provider_api_keys AS existing
    WHERE existing.workspace_id = provider_credentials.workspace_id
      AND existing.provider = provider_credentials.provider
  );

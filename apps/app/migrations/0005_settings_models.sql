-- 0005_settings_models.sql
-- Add model selection enhancements: thinking effort, heavy-duty model, fallback chain, min severity, and provider baseUrl

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS effort text NULL,
  ADD COLUMN IF NOT EXISTS heavy_provider text NULL,
  ADD COLUMN IF NOT EXISTS heavy_model text NULL,
  ADD COLUMN IF NOT EXISTS heavy_effort text NULL,
  ADD COLUMN IF NOT EXISTS heavy_threshold_lines integer NULL DEFAULT 800,
  ADD COLUMN IF NOT EXISTS fallback jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS min_severity text NOT NULL DEFAULT 'medium';

ALTER TABLE provider_credentials
  ADD COLUMN IF NOT EXISTS base_url text NULL;

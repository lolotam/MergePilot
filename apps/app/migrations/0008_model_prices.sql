-- 0008_model_prices.sql
-- Automatic model prices (ADR-0016): a daily job copies public price lists (OpenRouter, Vercel AI
-- Gateway, models.dev) into `model_prices`, so a run's cost is known without a repo price table.
-- One row per (provider, model); each source's rows are replaced together when that source
-- fetched OK, so a failed refresh keeps the stored (stale) prices. Prices are USD per million tokens.

CREATE TABLE IF NOT EXISTS model_prices (
  provider text NOT NULL,
  model text NOT NULL,
  input_per_mtok numeric(12, 6) NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok numeric(12, 6) NOT NULL CHECK (output_per_mtok >= 0),
  cache_read_per_mtok numeric(12, 6) NULL CHECK (cache_read_per_mtok IS NULL OR cache_read_per_mtok >= 0),
  cache_write_per_mtok numeric(12, 6) NULL CHECK (cache_write_per_mtok IS NULL OR cache_write_per_mtok >= 0),
  source text NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (provider, model)
);

-- The case-insensitive lookup (after the exact match) and "newest fetched_at per source".
CREATE INDEX IF NOT EXISTS idx_model_prices_lower ON model_prices (lower(provider), lower(model));
CREATE INDEX IF NOT EXISTS idx_model_prices_source_fetched_at ON model_prices (source, fetched_at DESC);

-- Manual prices per workspace: an ordered list of at most 50
-- `{provider, model, inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok?}` entries
-- (validated by the API). They win over the repo file and the catalog.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS price_overrides jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (CASE WHEN jsonb_typeof(price_overrides) = 'array' THEN jsonb_array_length(price_overrides) <= 50 ELSE false END);

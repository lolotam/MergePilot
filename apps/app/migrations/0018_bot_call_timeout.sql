-- Per-bot optional call timeout override in ms (1000-1200000); null = inherit the effective
-- timeout (the repository's or the engine default). The REST bounds live in the API contract.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS call_timeout_ms integer
  CHECK (call_timeout_ms IS NULL OR (call_timeout_ms >= 1000 AND call_timeout_ms <= 1200000));

ALTER TABLE reviewer_bots
  ADD COLUMN IF NOT EXISTS call_timeout_ms integer
  CHECK (call_timeout_ms IS NULL OR (call_timeout_ms >= 1000 AND call_timeout_ms <= 1200000));

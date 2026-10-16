-- 0013_max_findings.sql
-- The workspace's findings limit per published review (ADR-0033): the dashboard offers
-- 5, 10, ..., 50. A repository's `.mergepilot.yml` `review.maxFindings` (1-50) overrides it.
-- The default 5 keeps every existing workspace's reviews as they were.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS max_findings smallint NOT NULL DEFAULT 5
    CHECK (max_findings BETWEEN 5 AND 50 AND max_findings % 5 = 0);

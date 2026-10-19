-- Workspace per-bot API spending cap (ADR-0036). Repository budget.perReviewUsd wins.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS per_review_usd numeric(10,2) NOT NULL DEFAULT 0.50
    CHECK (per_review_usd >= 0.50 AND per_review_usd <= 1000);

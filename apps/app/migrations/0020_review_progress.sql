ALTER TABLE review_runs ADD COLUMN attempt_id text;
ALTER TABLE review_runs ADD COLUMN review_progress jsonb;
ALTER TABLE review_runs ADD COLUMN review_started_at timestamptz;

-- 0010_judge_uses.sql
-- Jev judge multi-use (ADR-0015 amendment «multi-use»): the single `judge_mode` becomes a set of
-- uses, zero or more of annotate | filter | dedupe | consensus. An empty set with the judge enabled
-- is allowed: the judge is idle.
--
-- Backfill from `judge_mode`, keeping today's behaviour (the duplicate check always ran):
--   off -> {dedupe}, annotate -> {annotate,dedupe}, filter -> {filter,dedupe}.
--
-- `judge_mode` is kept for one release so a rollback still finds it. The app no longer reads it;
-- it only writes the closest old mode there (filter, else annotate, else off). Drop it in a later
-- migration.
--
-- The column and its backfill are added together, once: re-running this file changes nothing, so
-- it never overwrites uses saved after the first run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'workspace_settings' AND column_name = 'judge_uses'
  ) THEN
    ALTER TABLE workspace_settings
      ADD COLUMN judge_uses text[] NOT NULL DEFAULT '{}'
        CONSTRAINT workspace_settings_judge_uses_check
        CHECK (judge_uses <@ ARRAY['annotate', 'filter', 'dedupe', 'consensus']::text[]);

    UPDATE workspace_settings
    SET judge_uses = CASE judge_mode
      WHEN 'annotate' THEN ARRAY['annotate', 'dedupe']::text[]
      WHEN 'filter' THEN ARRAY['filter', 'dedupe']::text[]
      ELSE ARRAY['dedupe']::text[]
    END;
  END IF;
END $$;

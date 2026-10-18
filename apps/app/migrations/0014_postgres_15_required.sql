-- 0014_postgres_15_required.sql
-- 0014_review_skills.sql uses `ON DELETE SET NULL (skill_id)`, which needs PostgreSQL 15 or later
-- (we deploy 17). A server parses a whole migration file before running it, so this check lives in
-- its own file, applied first (name order): an older server stops here with a clear message
-- instead of a syntax error in the next file.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'MergePilot migrations from 0014 need PostgreSQL 15 or later (found %)', current_setting('server_version');
  END IF;
END $$;

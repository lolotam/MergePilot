-- 0019_web_scan.sql
-- Website security scan storage (ADR-0052).
--
-- These rows are platform-global. The scanner is a platform-admin feature, so none of the
-- tables below carries a workspace id and none of them references the "organization" table:
-- a workspace user route can never reach them, and deleting a workspace can never delete a
-- scan, a site or an audit row.
--
-- The migration runner applies this file in one transaction. Every statement is therefore
-- safe to re-run after a rollback.

-- ---------------------------------------------------------------------------
-- 1. The global settings row.
-- ---------------------------------------------------------------------------
-- Exactly one row exists. The fixed id plus the check constraint below make a second row
-- impossible, so the settings can never be duplicated by a concurrent insert.
CREATE TABLE IF NOT EXISTS web_scan_settings (
  id uuid PRIMARY KEY DEFAULT '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'::uuid,
  -- The kill switch. A new deployment starts paused: no site and no schedule exists yet.
  paused boolean NOT NULL DEFAULT true,
  -- Notifications are off until an administrator turns them on.
  alerts_enabled boolean NOT NULL DEFAULT false,
  max_requests integer NOT NULL DEFAULT 500 CHECK (max_requests BETWEEN 1 AND 2000),
  max_pages integer NOT NULL DEFAULT 100 CHECK (max_pages BETWEEN 1 AND 300),
  max_active_links integer NOT NULL DEFAULT 30 CHECK (max_active_links BETWEEN 1 AND 100),
  requests_per_second integer NOT NULL DEFAULT 2 CHECK (requests_per_second BETWEEN 1 AND 5),
  request_timeout_ms integer NOT NULL DEFAULT 10000 CHECK (request_timeout_ms BETWEEN 1000 AND 30000),
  max_response_bytes integer NOT NULL DEFAULT 1048576 CHECK (max_response_bytes BETWEEN 1024 AND 5242880),
  total_timeout_ms integer NOT NULL DEFAULT 1200000 CHECK (total_timeout_ms BETWEEN 60000 AND 3600000),
  -- How long a retained occurrence and a scan snapshot survive.
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 1 AND 3650),
  -- The contact shown in a notification. It is never a credential.
  contact text NOT NULL DEFAULT '',
  alert_min_severity text NOT NULL DEFAULT 'high'
    CHECK (alert_min_severity IN ('critical', 'high', 'medium', 'low', 'info')),
  alert_min_validation text NOT NULL DEFAULT 'Likely'
    CHECK (alert_min_validation IN ('Confirmed', 'Likely', 'Indicator', 'Informational')),
  -- An on/off switch for each of the six checks. The active-content check stays off until
  -- path and parameter opt-in exists.
  checks jsonb NOT NULL DEFAULT
    '{"headers":true,"cookies":true,"transport":true,"disclosure":true,"files":true,"active":false}'::jsonb,
  -- The default schedule, disabled. No site and no schedule exists after this migration.
  default_schedule jsonb NOT NULL DEFAULT
    '{"frequency":"weekly","weekday":5,"hour":4,"minute":0,"enabled":false}'::jsonb,
  -- The approved (admin_user_id, installation_id, github_account_id) triples.
  approved_installations jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,
  CONSTRAINT web_scan_settings_single_row
    CHECK (id = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'::uuid)
);

-- The seeded row: paused, alerts off, no sites, no schedules, no approved installation.
INSERT INTO web_scan_settings (id) VALUES ('0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'::uuid)
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The sites.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_scan_sites (
  id uuid PRIMARY KEY,
  -- The canonical hostname, without a scheme, a path or a query.
  hostname text NOT NULL CHECK (char_length(hostname) BETWEEN 1 AND 253),
  -- The origin the scanner starts from. It never carries a query string.
  base_url text NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 300),
  -- The platform administrator who owns this site.
  owner_user_id text NOT NULL,
  -- The optional repository binding. A scan without a repository binding only writes a report.
  repository_owner text NULL,
  repository_name text NULL,
  repository_id bigint NULL,
  installation_id bigint NULL,
  github_account_id bigint NULL,
  -- The site identity key, sealed with the purpose-scoped vault. The key bytes are never
  -- stored in the clear and never leave this table.
  identity_key_ciphertext text NOT NULL,
  identity_key_version integer NOT NULL CHECK (identity_key_version > 0),
  -- The per-site scope overrides.
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The per-site schedule, null when the site is not scheduled.
  schedule jsonb NULL,
  -- The authorization that allows scanning this site.
  authorization_audit_id uuid NULL,
  authorized_by text NULL,
  authorized_at timestamptz NULL,
  -- Bumped whenever the scope or the schedule changes. A queued scan records the version it
  -- was authorized under, so a later change invalidates it.
  scope_version integer NOT NULL DEFAULT 1 CHECK (scope_version > 0),
  -- The bounded alert-episode state of the site. It lives on the site row so it survives the
  -- expiry of the scan snapshots it was derived from.
  alert_episodes jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The coverage of the last completed scan. It lives on the site row, next to the episode
  -- state, so the current coverage of a site survives the expiry of the snapshot it was
  -- produced by. Only a completed scan writes it: a stopped or failed run proves nothing.
  last_coverage_summary jsonb NULL,
  last_coverage_scan_id uuid NULL,
  last_coverage_at timestamptz NULL,
  next_run_at timestamptz NULL,
  last_scan_at timestamptz NULL,
  -- A removed site keeps its row: its history, its identity key and its exceptions survive.
  removed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_scan_sites_repository_binding CHECK (
    (repository_id IS NULL AND installation_id IS NULL AND github_account_id IS NULL)
    OR (repository_id IS NOT NULL AND installation_id IS NOT NULL AND github_account_id IS NOT NULL)
  )
);

-- One site per hostname. The index is on the lower-cased hostname so two spellings of the
-- same host cannot both exist. A tombstoned site keeps its row, so a later registration of
-- the same hostname restores it instead of creating a second one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_scan_sites_hostname
  ON web_scan_sites (lower(hostname));

CREATE INDEX IF NOT EXISTS idx_web_scan_sites_next_run
  ON web_scan_sites (next_run_at)
  WHERE removed_at IS NULL AND next_run_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The scans.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES web_scan_sites (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'stopped', 'failed')),
  -- The slot a scheduled scan belongs to. A manual scan has none.
  scheduled_for timestamptz NULL,
  -- The administrator-generated idempotency key of a manual scan.
  idempotency_key text NULL,
  -- The fingerprint of the request data behind that key. The same key with a different
  -- fingerprint is a conflict, not a replay.
  request_fingerprint text NULL,
  -- The outbox state of the queued intent. It is written in the same transaction as the
  -- intent itself, so a scan is never queued without a durable record of the queue.
  outbox_state text NOT NULL DEFAULT 'pending'
    CHECK (outbox_state IN ('pending', 'published', 'unknown')),
  outbox_published_at timestamptz NULL,
  -- The attempt and the heartbeat of the worker that owns the scan.
  attempt_id text NULL,
  heartbeat_at timestamptz NULL,
  -- The typed terminal reason.
  stop_reason text NULL,
  fail_reason text NULL,
  -- The final counters.
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  pages integer NOT NULL DEFAULT 0 CHECK (pages >= 0),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  -- The settings the scan actually ran under.
  effective_settings jsonb NOT NULL,
  -- The coverage of the last completed scan.
  coverage_summary jsonb NULL,
  -- The authorization the scan was queued under.
  authorization_audit_id uuid NULL,
  scope_version integer NOT NULL CHECK (scope_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A manual scan always carries an idempotency key and its request fingerprint.
  CONSTRAINT web_scans_manual_idempotency CHECK (
    trigger <> 'manual'
    OR (idempotency_key IS NOT NULL AND request_fingerprint IS NOT NULL)
  ),
  -- A scheduled scan always belongs to a slot.
  CONSTRAINT web_scans_scheduled_slot CHECK (
    trigger <> 'scheduled' OR scheduled_for IS NOT NULL
  )
);

-- One scheduled scan per site and slot. A repeated scheduler run finds the row instead of
-- queueing a second scan for the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_scans_site_scheduled_for
  ON web_scans (site_id, scheduled_for)
  WHERE trigger = 'scheduled';

-- One manual scan per site and idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_scans_site_manual_idempotency
  ON web_scans (site_id, idempotency_key)
  WHERE trigger = 'manual';

CREATE INDEX IF NOT EXISTS idx_web_scans_site_created
  ON web_scans (site_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. The findings of a scan.
-- ---------------------------------------------------------------------------
-- The findings of one scan. They expire with the scan; the retained state of an issue lives
-- in web_scan_occurrences below.
CREATE TABLE IF NOT EXISTS web_scan_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES web_scans (id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES web_scan_sites (id) ON DELETE CASCADE,
  issue_key text NOT NULL,
  occurrence_key text NOT NULL,
  target_key text NOT NULL,
  check_id text NOT NULL,
  check_version integer NOT NULL,
  issue_id text NOT NULL,
  subject text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  validation text NOT NULL
    CHECK (validation IN ('Confirmed', 'Likely', 'Indicator', 'Informational')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  risk_score numeric(6, 3) NULL,
  risk_factors jsonb NULL,
  -- The safe location: never a header value, a query string or a response body.
  safe_location text NOT NULL,
  -- The safe evidence, null when the evidence was pruned.
  evidence jsonb NULL,
  evidence_hash text NOT NULL,
  comparison text NOT NULL CHECK (comparison IN ('New', 'Unchanged', 'Fixed', 'Not checked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_web_scan_findings_scan_occurrence
  ON web_scan_findings (scan_id, occurrence_key);

-- ---------------------------------------------------------------------------
-- 5. The exceptions.
-- ---------------------------------------------------------------------------
-- An administrator decision about one occurrence. It applies only while the occurrence key
-- and the evidence hash still match.
CREATE TABLE IF NOT EXISTS web_scan_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES web_scan_sites (id) ON DELETE CASCADE,
  occurrence_key text NOT NULL,
  evidence_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('accepted', 'false_positive')),
  reason_category text NOT NULL CHECK (reason_category IN (
    'not_applicable', 'already_mitigated', 'accepted_risk', 'out_of_scope',
    'third_party_dependency', 'test_environment'
  )),
  -- The free-form reason. It is never published.
  reason text NOT NULL,
  -- The exception stops applying at this moment.
  expires_at timestamptz NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  revoked_by text NULL
);

CREATE INDEX IF NOT EXISTS idx_web_scan_exceptions_site_occurrence
  ON web_scan_exceptions (site_id, occurrence_key);

-- ---------------------------------------------------------------------------
-- 6. The retained occurrences.
-- ---------------------------------------------------------------------------
-- The latest state of every issue the scanner has seen on a site. This table is independent
-- of the scan snapshots above: it survives their expiry.
CREATE TABLE IF NOT EXISTS web_scan_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES web_scan_sites (id) ON DELETE CASCADE,
  -- The identity of the occurrence. It is unique per site.
  occurrence_key text NOT NULL,
  target_key text NOT NULL,
  issue_key text NOT NULL,
  check_id text NOT NULL,
  check_version integer NOT NULL,
  issue_id text NOT NULL,
  subject text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  validation text NOT NULL
    CHECK (validation IN ('Confirmed', 'Likely', 'Indicator', 'Informational')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  safe_location text NOT NULL,
  evidence_hash text NOT NULL,
  -- The evidence, null once the occurrence became a tombstone.
  evidence jsonb NULL,
  -- outstanding: still seen. fixed: a completed scan proved it gone.
  -- archived: it was not observed for the whole retention horizon.
  state text NOT NULL CHECK (state IN ('outstanding', 'fixed', 'archived')),
  archive_reason text NULL
    CHECK (archive_reason IS NULL OR archive_reason IN ('unobserved_retention', 'retired_catalogue')),
  comparison text NULL
    CHECK (comparison IS NULL OR comparison IN ('New', 'Unchanged', 'Fixed', 'Not checked')),
  -- When the occurrence was last observed.
  last_observed_at timestamptz NOT NULL,
  -- The last completed scan that evaluated this exact target and check.
  last_completed_scan_id uuid NULL REFERENCES web_scans (id) ON DELETE SET NULL,
  -- The exception that pinned this occurrence, when it was archived behind a resolution.
  exception_id uuid NULL REFERENCES web_scan_exceptions (id) ON DELETE SET NULL,
  -- The alert episode this occurrence belongs to.
  notification_episode_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_scan_occurrences_unique_site_occurrence UNIQUE (site_id, occurrence_key),
  -- An archived occurrence always says why.
  CONSTRAINT web_scan_occurrences_archive_reason CHECK (
    state <> 'archived' OR archive_reason IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_web_scan_occurrences_site_state
  ON web_scan_occurrences (site_id, state);

CREATE INDEX IF NOT EXISTS idx_web_scan_occurrences_last_observed
  ON web_scan_occurrences (site_id, last_observed_at);

-- ---------------------------------------------------------------------------
-- 7. The alerts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_scan_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES web_scan_sites (id) ON DELETE CASCADE,
  issue_key text NOT NULL,
  -- The episode key. It groups the occurrences of one alert episode.
  episode_key text NOT NULL,
  repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  github_account_id bigint NOT NULL,
  issue_number integer NULL,
  -- The marker that makes a delivery idempotent.
  delivery_marker text NOT NULL,
  delivery_state text NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'sent', 'unknown', 'closed')),
  issue_state text NOT NULL DEFAULT 'unknown' CHECK (issue_state IN ('open', 'closed', 'unknown')),
  -- The occurrence keys the episode covers.
  occurrence_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_delivered_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_scan_alerts_marker_unique UNIQUE (delivery_marker)
);

CREATE INDEX IF NOT EXISTS idx_web_scan_alerts_site_issue
  ON web_scan_alerts (site_id, issue_key);

-- ---------------------------------------------------------------------------
-- 8. The audit log.
-- ---------------------------------------------------------------------------
-- One row per audited change. The store only ever inserts here; there is no update and no
-- delete path in the store.
CREATE TABLE IF NOT EXISTS web_scan_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  -- The state before and after the change. The store strips every secret before it writes.
  before jsonb NULL,
  after jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_scan_audit_created_at
  ON web_scan_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_scan_audit_target
  ON web_scan_audit (target_type, target_id);

-- The database refuses to change or remove an audit row.
--
-- The guard is a trigger that raises, not a REVOKE: it needs no extra role and no grant
-- change, so it behaves the same for the migration role that owns the table and for the
-- runtime role that only writes through the store. The function runs as the invoker and
-- only raises, so it never needs privileges of its own.
CREATE OR REPLACE FUNCTION web_scan_audit_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'web_scan_audit is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS web_scan_audit_append_only ON web_scan_audit;

CREATE TRIGGER web_scan_audit_append_only
  BEFORE UPDATE OR DELETE ON web_scan_audit
  FOR EACH ROW EXECUTE FUNCTION web_scan_audit_reject_mutation();

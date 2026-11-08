# Migration 0020 safety and rollback proposal

Status: LOCAL PROPOSAL. No production execution or deployment authorization.

## Why a migration

There is no dedicated durable attempt-scoped progress field in the existing schema. Reusing `result` would confuse provisional metadata with final findings/usage; using terminal status would release active uniqueness and alter accounting/deletion. Three nullable columns keep those boundaries intact: text `attempt_id`, timestamptz `review_started_at`, jsonb `review_progress`.

## Before approved rollout

1. Obtain the independent production migration/deployment decision. Identify the database and application release SHA explicitly in that decision.
2. Confirm a recent database backup and tested restore procedure with the operator. Do not copy secrets into this record.
3. Confirm migration ledger contains 0019 and does not contain 0020; verify no long-running transaction holds `review_runs`. The ALTER needs an access-exclusive table lock even though no backfill/default is added. Schedule accordingly; abort rather than waiting indefinitely on production locks.
4. Review the exact SQL in `apps/app/migrations/0020_review_progress.sql`. It only adds nullable columns; no data updates, drops, indexes or defaults. Run via the existing transactional migration runner and its advisory lock after approval, with an operator-approved lock timeout for that session.
5. Deploy new API/workers only after schema commit. Before new workers consume jobs, drain old workers and verify zero in-flight jobs; pause queue consumption during the version transition. Do not interrupt live reviews or allow mixed-version consumers. Old binaries ignore added columns, but old-worker retries do not reset progress and are not supported after new progress exists. Do not run new binaries against the old schema. See [ADR-0054](adr/0054-dashboard-review-progress.md).

## Verification after approved application

Read-only inspection (operator runs on the explicitly approved target):

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'review_runs'
  AND column_name IN ('attempt_id', 'review_started_at', 'review_progress');
SELECT name FROM schema_migrations WHERE name = '0020_review_progress.sql';
```

Expect three nullable columns and exactly one ledger record. Verify existing historical runs still list; observe only already-authorized reviews, never start paid test reviews. Confirm completed bot timers freeze while job state remains active until publication.

## Rollback

If migration fails, the existing migration runner rolls back its transaction, including the ledger insert. Diagnose locks/schema state before a retry; never mark the ledger manually. If application rollout fails after migration succeeds, retain all three columns and their data. The previous API release may be restored, but keep old workers stopped and queue consumption paused until a compatible forward fix is available. Old-worker retries would preserve stale attempt metadata, so restoring old worker consumption is prohibited. If old workers have already retried rows, require a separately reviewed reconciliation plan before redeployment; do not claim those records safe. Do not drop columns or delete progress during an operational rollback. Removing them later is a separately reviewed destructive migration requiring preservation of any needed audit data. Existing active jobs must settle through ordinary worker/retry/stale-run handling; do not force-finish jobs to roll back. ADR-0025 disables ordinary automatic application rollback for a release containing migrations: failure/HOLD disposition belongs to the operator and owner.

## Local evidence

Real PGlite migration/store tests and the explicit admin migration fixture cover the additive schema and reads/writes. This is not production lock-duration measurement or PostgreSQL server integration validation. Production gate remains independent.

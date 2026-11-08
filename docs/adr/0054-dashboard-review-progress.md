# ADR-0054: Attempt-scoped dashboard review progress

Status: Accepted design; production rollout requires the independent migration/deployment gate.

## Context

Each bot must show its review outcome before siblings or publication finish in both panel modes. Finishing the job early would release active-run uniqueness and change heartbeat, retry, deletion and usage accounting. Reusing final result payloads would mix provisional metadata with findings and usage.

## Decision

Store review progress separately in three nullable `review_runs` columns: `attempt_id`, `review_started_at` and `review_progress`. New attempts receive a fresh UUID and clear progress. Writes require matching workspace, run and attempt identities and null prior progress. A running attempt, or the same attempt marked failed with `detail=interrupted` by stale recovery, can record its review outcome. Other terminal states reject writes.

The API exposes optional progress/start metadata without exposing the internal attempt identity. Dashboard timers freeze at review completion; publication and raw job status remain separate. Active uniqueness, heartbeats, usage, retry eligibility, polling and deletion continue using job lifecycle status. Expanded rows represent each run ID once and preserve history. Rows retain table semantics; native details/expand/retry controls remain independently accessible.

Progress persistence is auxiliary: transient write errors log identifiers only and do not suppress publication. Workspace deletion remains fatal to publication. A failed progress write degrades to legacy timing/status presentation rather than inventing a completion record.

## Compatibility and operations

Migration `0020_review_progress.sql` adds nullable columns without a backfill or default. New binaries require schema-first deployment. Old binaries ignore the columns, but old workers cannot safely reuse rows containing new progress: their retry update does not clear these fields. Therefore mixed-version worker consumption is prohibited. Drain old workers and confirm no in-flight jobs before new workers consume jobs. Do not silently interrupt active reviews to meet this gate.

Application rollback retains schema and progress. Previous API binaries can serve historical data; previous workers must remain stopped, with review queue consumption paused, until a compatible forward fix is available. Do not resume old-worker retries or redeploy new workers over a database that old workers have mutated without an explicit reconciliation plan. This trades temporary review availability for correct attempt metadata without an additional trigger or destructive cleanup.

Verify backup/restore, bounded lock acquisition, approved target and exact release SHA before rollout. Under ADR-0025 a release with a migration does not use the ordinary automatic application rollback; failure requires operator disposition. No production execution is implied by this ADR.

Detailed procedure: [migration safety and rollback](../review-progress-migration-safety.md).

## Validation

Memory/PGlite parity tests cover identity isolation, retries, stale recovery, terminal and duplicate writes. Worker tests cover both modes, independent completion before publication, publication failure, transient progress errors and workspace deletion. Dashboard tests cover unique expanded rows, independent timers and nested native controls. Server integration and exact-head CI remain delivery evidence rather than architectural assumptions.

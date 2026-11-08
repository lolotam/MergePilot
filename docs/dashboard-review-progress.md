# Dashboard bot review progress

Each bot exposes its review outcome and completion timestamp independently in both panel modes. Completed means its review pipeline finished; it does not mean GitHub publication succeeded. The dashboard freezes that bot's review timer while siblings continue running. A separate finishing label and terminal job-failure label distinguish the remaining job lifecycle from the review outcome; a failed review is not automatically described as a publication failure. Polling, deletion eligibility, active uniqueness, heartbeats and budget usage continue to use the job status.

Expanding a PR represents the main bot in the parent row and each other record once below it. History is retained by run id, including earlier heads and repeated slots. The collapsed row retains aggregate tokens/cost and the latest run sort key; expanded cells describe individual runs. Filters still select job lifecycle status, and duration sorting still uses final job duration, not the independent review timer.

## Persistence and rollout proposal

Migration `0020_review_progress.sql` adds nullable `attempt_id`, `review_started_at` and `review_progress` columns. Dedicated metadata avoids provisional findings or invented usage in final result payloads. Every create/reuse generates a fresh UUID and resets review progress, including retry timers. Progress writes compare workspace, run id, attempt UUID, eligible lifecycle state (running or interrupted by the stale sweep) and absent prior progress atomically. Finalization preserves the review outcome when publication fails. Historical rows without progress use the existing status/timestamps.

Apply the additive migration before starting the new web/worker version. Existing workers ignore the columns; new workers need them. No data backfill or destructive changes. Rollback the application without dropping columns; do not erase progress. Production migration and deployment require their own approval. This task only executes migrations inside disposable local PGlite tests.

Old-worker retries are not supported after progress exists. Drain old consumers before enabling new ones; on rollback keep old consumers stopped until a compatible forward fix. Preserve the columns and progress data.

Architecture: [ADR-0054](adr/0054-dashboard-review-progress.md). Detailed production proposal: [Migration safety and rollback](review-progress-migration-safety.md).

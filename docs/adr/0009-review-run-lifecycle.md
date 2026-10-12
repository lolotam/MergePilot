# ADR-0009: Review run lifecycle — one row per job, heartbeat, stale sweep

## Context

On the live server every deploy restarted the worker while reviews were in flight. Their
`review_runs` rows stayed `running` forever, and BullMQ's retry created a second row for the same
job. A sweep based on `created_at` would fail reviews that are slow but still alive.

## Decision

- A run carries the BullMQ `job_id`. A retried job reuses its run only while that run is
  `queued`, `running` or `failed`; a `completed` or `skipped` run is never overwritten (a new run
  is created). The uniqueness of `(workspace_id, job_id)` is enforced by a partial index over those
  active statuses only.
- A run has `updated_at`, set on create, reuse, finish and every 60 seconds by the worker while the
  review is in progress (a heartbeat).
- The worker sweeps at start and every 5 minutes: a `queued`/`running` run without a heartbeat for
  15 minutes is marked `failed` with detail `interrupted`.

## Consequences

- Deploys no longer leave runs stuck in `running`; the dashboard shows them as interrupted and they
  can be retried.
- A live review is never swept while its worker is alive.
- One extra small UPDATE per minute per active review.

## Amendment (2026-10-12): one active run per PR head

Retrying a run from the dashboard (one run, or "retry all failed") made "is a run for this
repo + PR + head already queued or running?" a check-then-insert race, both between two retry
requests and between a retry and a webhook job for the same commit.

- Migration `0004_active_run_unique.sql` adds a partial unique index on `review_runs
  (workspace_id, repo_full_name, pull_number, head_sha) WHERE status IN ('queued', 'running')`.
  Older duplicate active rows are closed as `failed` / `duplicate` before the index is created.
- `createReviewRun` surfaces a conflict as the typed `ActiveRunExistsError` (the memory store
  emulates the index). The retry endpoints report it as 409 `already_running` or as a skipped
  `already_running` item; the worker ends that job as `skipped` with detail `duplicate`, before any
  GitHub call, so nothing is published and the job is not retried.
- Job-id reuse is unchanged: a job reuses its own row, so moving that row from `queued` to
  `running` never conflicts with itself. Reusing a `failed` row while another run for the same head
  is active is refused with the same error, and that row stays `failed`.
- The read-only `findActiveReviewRun` pre-check stays for clear early answers (and the dry run), but
  correctness comes from the index.

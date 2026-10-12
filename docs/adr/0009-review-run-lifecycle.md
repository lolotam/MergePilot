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

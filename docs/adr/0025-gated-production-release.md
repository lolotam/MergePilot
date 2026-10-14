# ADR-0025: Gated production release

**Date:** 2026-10-15 · **Status:** proposed (implemented, dry run only; activation pending owner decision) · **Owner decision:** decisions log س40

## Context

Production (Dokploy compose on musalam-2) reads `deploy/docker-compose.dokploy.yml` from `main` and is deployed by hand: someone edits the `x-image` pin and presses Deploy. The owner asked for an automatic release after merge, but only for a commit whose CI, Integration and image checks all succeeded on that exact SHA, pinned by digest, one release at a time, verified on the running containers, and rolled back without touching the database.

## Decision

1. **One mechanism: a GitHub workflow calls the Dokploy Compose API.** `.github/workflows/release.yml` runs on `workflow_run` (completed) of `CI`, `Integration Tests` and `Docker Image` for `push` events on `main` from this repository, or by `workflow_dispatch` with a full SHA. It never runs for pull requests, forks or other branches. Dokploy's own webhook/autoDeploy is not relied on.
2. **Same-SHA gate** (`scripts/release/core.ts` `evaluateChecks`): the check runs `check`, `integration` and `Build and Push Docker Image` must be completed with `success` for the candidate SHA; runs for another SHA are ignored and a re-run counts by its latest attempt. Pending or missing checks wait; any other conclusion blocks. A commit that changes no image-building path (the `docker.yml` push paths, kept equal by a test) is skipped as docs-only. A commit that is not on `main` is blocked before any check is read.
3. **Order and idempotency** (`decideRelease`): a candidate equal to or older than the deployed commit is skipped; a deployed commit that is not an ancestor of the candidate (rolled back, rewritten) blocks for a person.
4. **Immutable pin, one source of truth.** The registry is asked for the digest of `ghcr.io/lolotam/mergepilot:<sha>`, and its `org.opencontainers.image.revision` label must equal the SHA. The release writes `x-image: &image <repo>:<sha>@sha256:<digest>`; `migrate`, `web` and `worker` all use `*image`. The pin lives in a **release commit on a machine-owned branch** (`production` by default) whose parent is the source commit, with trailers `Source-Commit`, `Image-Ref`, `Previous-Source-Commit`, `Previous-Image-Ref`. That branch head is the record of what runs. Writing it checks the expected head first, so a concurrent writer fails instead of overwriting.
5. **No loops.** A commit whose subject starts with `chore(release): deploy ` is never released; release commits go to the release branch, never `main`; the gate workflows do not run on that branch; and pushes made with `GITHUB_TOKEN` do not start workflows.
6. **Concurrency.** `concurrency: production-release` with `cancel-in-progress: false`: one release at a time and a running deploy is never cancelled. A newer queued run replaces an older queued one, and rule 3 refuses anything older than what runs. The job allows 120 minutes, enough for a forward deploy and a rollback in full (2 × (35 + 10) minutes plus a 20-minute reserve for setup and for each poll overrunning by one attempt; every HTTP request has a 60-second deadline); the script refuses `DEPLOY_TIMEOUT_MINUTES`/`VERIFY_TIMEOUT_MINUTES` values that would not fit, so a job is never cancelled mid-rollback before the hold issue is opened.
7. **Verification** (`scripts/release/verify.ts`), polled until a timeout: the Dokploy deployment ends `done`; `migrate` exited 0; `postgres` and `redis` running and healthy; `web` and `worker` running, healthy, on the pinned image reference and with the source SHA as revision label; and `PRODUCTION_URL/health` returns 200 with `{"ok":true}`. `/health` alone is not taken as proof of version.
8. **Rollback.** On failure the release opens a `release-hold` issue (which blocks every later release until closed) and fails the job. It rolls back automatically only when no file under `apps/app/migrations/` changed between the two releases, by writing a rollback release commit with the previous pin and deploying it. It never deletes volumes and never downgrades or restores the database.
9. **Worker drain.** On SIGTERM the worker calls `worker.close()`; the compose file sets `stop_grace_period: ${WORKER_STOP_GRACE_PERIOD:-10s}` so the drain length is an operator setting (Docker's default stays until the owner chooses one).
10. **Disabled by default.** Live mode only when the repository variable `MERGEPILOT_AUTO_RELEASE` is `enabled`; otherwise the workflow is a dry run that commits and deploys nothing. Deleting the variable disables releases again. Credentials are named, never logged: secret `DOKPLOY_API_KEY`; variables `DOKPLOY_URL`, `DOKPLOY_COMPOSE_ID`, `DOKPLOY_APP_NAME`, optional `RELEASE_BRANCH`, `PRODUCTION_URL`, `DEPLOY_TIMEOUT_MINUTES`. Response bodies of Dokploy are not logged because they contain the compose environment.

## Pending owner decisions (before activation)

- Switch the Dokploy compose source branch from `main` to `production` with autoDeploy off, after bootstrapping `production` at the currently deployed commit.
- The worker grace period (`WORKER_STOP_GRACE_PERIOD`, proposed 25m against the 15-minute stale-run sweep; alternative 12m).
- Branch protection on `main` requiring the three checks.
- A dedicated Dokploy API user/key for `DOKPLOY_API_KEY`.
- The policy itself: until `MERGEPILOT_AUTO_RELEASE=enabled` is set, the owner-approval rule for deploys stays.

## Consequences

- No deploy happens without the three green checks on the same SHA and a pushed image whose revision matches it.
- A failed release stops the pipeline until a person closes the hold issue.
- Deploys are not zero-downtime: Compose recreates `web` and `worker`, and a drain longer than the grace period interrupts running reviews.
- Not verifiable before merge: `workflow_run` and `workflow_dispatch` fire only once the workflow is on the default branch, and the live Dokploy calls need the key. The first live release is the acceptance test.

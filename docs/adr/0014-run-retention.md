# ADR-0014: Run Retention — Bulk Delete, Nightly Cleanup, Monthly Usage Summary, Grouped Runs Table

- **Status:** Accepted (2026-10-12)
- **Related to:** ADR-0007, ADR-0009, docs/decisions.ar.md (batch 8, Q20–Q24)

## Context

`review_runs` grows forever: every push to every PR adds a row with its full result payload.
The owner asked for a bulk delete in the dashboard and a scheduled cleanup, and decided:
keep 30 days by default, each workspace may pick 30 / 90 / 180 / 365 days or forever, deletion is
permanent, and a monthly usage summary is kept so budgets and costs stay correct.

Until now the monthly budget check and the dashboard's month cost summed `review_runs.cost_usd`,
so deleting runs would have lowered the recorded spend and re-opened an exhausted budget.

The same batch reworked the runs table: one row per PR with expandable sub-rows, a `#` column,
token columns and a color per repository that the workspace can choose.

## Decision

1. **Monthly usage summary.** Migration 0006 adds `workspace_usage_monthly`
   (`workspace_id`, `month` = first day of the UTC month the run was *created* in, run counts,
   cost, input/output tokens). `finishReviewRun` with a finished status (completed / failed /
   skipped) adds the run to its month in the same transaction (an upsert that adds to the
   counters). The stale-run sweep adds the runs it fails. Every finish counts, so a retried run
   (ADR-0009 reuses a failed run's row) counts each attempt and its cost. `monthCostUsd` reads
   this table only, for the month of `monthStart` and later months; deleting runs never changes
   it. Workspace deletion deletes its usage rows (after the runs, in the same transaction). The
   migration backfills the table from existing finished runs with `ON CONFLICT DO NOTHING`.
2. **Retention setting.** `workspace_settings.run_retention_days integer NULL DEFAULT 30`
   (NULL = forever; existing rows get 30). The settings API accepts 30/90/180/365/null; left out on
   PUT keeps the stored value. A workspace without a settings row is treated as 30 days.
3. **Bulk delete.** `POST /api/workspaces/:id/runs/delete` (admin/owner) takes either up to 500
   run ids or the list filters plus `confirmCount`. All ids must be runs of the workspace (else
   404, nothing deleted); `confirmCount` must equal the number of runs the filters match now,
   counted over all statuses like the list's total (else 409 with `actual`). Only finished runs
   are deleted; queued/running runs are skipped, so `deleted` may be lower. The checks and the
   delete run in one transaction under the live-workspace lock. The filter conditions are the
   same function the list uses (`runFilterConditions`), so what is shown is what is deleted.
   Logged as `runs.bulk_delete` with counts only.
4. **Nightly retention job.** A BullMQ job scheduler (`maintenance` queue, `upsertJobScheduler`,
   cron `0 3 * * *`, tz UTC) runs in the worker. For each workspace with runs and a finite
   retention it deletes finished runs created before `now - days`, 1000 per statement, oldest
   first, with a 200 ms pause between full batches, until a batch comes back short. A workspace
   that fails does not stop the others; the first error is recorded. Logged as
   `maintenance.retention` (workspaces, deleted, ms).
5. **Lease instead of an advisory lock.** `maintenance_runs` records each run
   (kind, started/finished, deleted count, error). A partial unique index allows one unfinished
   run per kind; taking the lease is an `INSERT … ON CONFLICT DO NOTHING`. This works through a
   connection pool (a session-level `pg_try_advisory_lock` would need one pinned connection for
   the whole job), with PGlite in tests and with the memory store, and the row is the audit log
   the admin overview shows. A lease unfinished for 2 hours is closed as `abandoned` and taken
   over, so a crashed worker cannot block the job forever. Re-running is safe: deleting old rows
   is idempotent.
6. **Manual run.** `POST /api/admin/maintenance/run-retention` (platform admins) takes the same
   lease, answers 202 with the run id (409 `already_running` when held) and runs the cleanup in
   the web process. `GET /api/admin/maintenance` returns the last run for the Overview tab.
7. **Grouped runs list.** `GET …/runs?groupBy=pr` returns PR groups: each matching run is ranked
   inside its (repo, PR) by `created_at desc, id desc`; rank 1 (the latest matching run) carries
   the sort key and the paging, so a PR's runs never split across pages. A group has its matching
   runs, newest first, plus summed cost and tokens; the response also has `totalRuns` (the
   `confirmCount` for "delete all matching"). The flat mode is unchanged. List items now carry
   `inputTokens` / `outputTokens` from the result payload; both are sort keys. They also carry
   `durationMs` (`finished_at - created_at`; null while queued/running or when unknown), sorted by
   the `duration` key with NULLs last in both directions; the web shows a live timer for active runs.
8. **Repository colors.** A fixed palette of 10 keys; the web maps each key to literal Tailwind
   classes (leading-edge strip, light tint, chip). The default color is a 32-bit FNV-1a hash of the
   lowercased `owner/repo`. A workspace may override it per repo in
   `workspace_settings.repo_colors jsonb` (`owner/repo` → palette key, at most 500 entries,
   validated against the enum), saved through the settings API by admins/owners;
   `settings.changed` logs only the field name.

## Consequences

- Budgets and the dashboard's month cost survive any deletion. The admin overview's all-time
  cost still sums `review_runs` (its 30-day figure is unaffected because the shortest retention
  is 30 days); moving it to the summary is a follow-up.
- Runs finished by an old worker during a rolling deploy (after the migration, before the new
  worker starts) are not added to the summary; the window is short.
- Old review details are gone after the retention period; GitHub comments are untouched.
- `workspace_usage_monthly` is small (one row per workspace per month) and is never pruned.

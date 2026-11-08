# Dashboard bot progress implementation handoff

Base: `77c266a2549ec6dfe44340229b19eed8c51a180f` (fast-forward from `e88a214835dd1a0ec02f2c8092726d3a16187fdd`).

Task checkout: `C:/Users/waleed_Mohamed/.t3/worktrees/MergePilot/t3-0ff6903c`.
Validation snapshot and all installed dependencies/build outputs/logs: `E:/Dev/mergepilot-progress-t3-0ff6903c`.

## Behavior and review notes

- Independent, attempt-scoped bot review completion in both modes; separate publication callback runs after duplicate/judge processing and before GitHub publication. Consensus callback runs before waiting for siblings. Heartbeats and active lifecycle continue until final publication.
- Dedicated nullable progress columns, not provisional result findings/usage. A UUID changes on every create/reuse. Updates compare workspace/id/attempt/status and only write once. Terminal finish preserves progress, including publication errors. Retry resets progress and review start time.
- API carries progress, attempt start and job id. Dashboard stops review timers on progress, retains raw status for polling/deletion/filtering, and discloses the remaining finishing phase. A terminal failed job does not erase successful review completion.
- Expanded main row represents one run; remaining rows exclude only its exact id. Main selection stays within latest head/job when available. No slot-based deletion/deduplication of history. Collapsed rows retain totals; expanded cells describe individual bots.
- Local additive migration proposal: `0020_review_progress.sql`. Production migration/deployment not performed or authorized. Apply schema before new application; rollback application while retaining nullable columns. See `docs/dashboard-review-progress.md`.

## Validation

Declared `pnpm@12.11.2` verified. `pnpm install --frozen-lockfile --store-dir E:/Dev/mergepilot-progress-t3-0ff6903c/.pnpm-store` succeeded; no upgrades. `pnpm typecheck` ran before tests and passed. `pnpm lint` passed after moving store logic to existing helper files. `pnpm build` passed with Vite chunk-size warning. Initial focused suite passed 72 tests. Later concurrent revalidation encountered unexpected Vitest worker exits and Vite Windows exit `-1073741502`; these are retained in `api-tests.log` and earlier `build.log` evidence. Final sequential rerun results are recorded below.

No real provider calls, paid reviews, credentials/settings changes, external messages, production operations, dependency execution from a reviewed PR, or changes to dirty root/other worktrees. No browser/manual visual validation, full `pnpm check`, PostgreSQL server integration suite or Action bundle was run. PGlite tests execute the real SQL migrations and store implementation locally. Self-review only; independent parent review is the next gate.

## Changed files

- `apps/app/migrations/0020_review_progress.sql`
- `apps/app/src/admin/admin.fixtures.ts`
- `apps/app/src/admin/review-progress.test.ts`
- `apps/app/src/api/contract.ts`
- `apps/app/src/api/run-dto.ts`
- `apps/app/src/core/memory-store-runs.ts`
- `apps/app/src/core/memory-store.ts`
- `apps/app/src/core/review-progress.test.ts`
- `apps/app/src/core/types.ts`
- `apps/app/src/db/pg-runs.ts`
- `apps/app/src/db/pg-store.ts`
- `apps/app/src/db/schema.ts`
- `apps/app/src/worker/execute-review.ts`
- `apps/app/src/worker/review-bot.ts`
- `apps/app/src/worker/review-progress.test.ts`
- `apps/web/src/i18n/runs-ar.ts`
- `apps/web/src/i18n/runs-en.ts`
- `apps/web/src/pages/RunsPage.duration.test.tsx`
- `apps/web/src/pages/RunsPage.groups.test.tsx`
- `apps/web/src/runs/RunDuration.tsx`
- `apps/web/src/runs/RunGroupRows.test.tsx`
- `apps/web/src/runs/RunGroupRows.tsx`
- `docs/dashboard-review-progress-handoff.md`
- `docs/dashboard-review-progress.md`
- `docs/review-progress-migration-safety.md`
- `docs/usage.ar.md`

## Parent follow-up

Updated `apps/app/src/admin/admin.fixtures.ts` explicit migration list through 0020, with a dedicated real PGlite admin-fixture progress test. The manual `listPgLatestFailedRuns` projection includes all three new fields; shared Memory/Pg tests assert these survive latest-failed reads. Added `docs/review-progress-migration-safety.md` with production preflight, lock risk, read-only verification and application-only rollback retaining columns/data. No production execution.

Final verification commands (task-owned E:/Dev snapshot, unchanged Vitest worker/load/timeouts):

```powershell
pnpm typecheck
pnpm lint
pnpm exec vitest run apps/web/src/runs/RunGroupRows.test.tsx apps/app/src/core/review-progress.test.ts apps/app/src/db/pg-runs.test.ts apps/app/src/worker/review-progress.test.ts apps/app/src/worker/process-review-consensus.test.ts apps/app/src/worker/process-review-panel.test.ts apps/web/src/pages/RunsPage.groups.test.tsx apps/web/src/pages/RunsPage.duration.test.tsx apps/web/src/runs/RunsLive.test.tsx apps/web/src/api/useRunsLive.test.tsx apps/app/src/api/api-runs.test.ts apps/app/src/api/runs-duration.test.ts apps/app/src/api/runs-query.test.ts apps/app/src/api/runs-delete.test.ts apps/app/src/admin/review-progress.test.ts apps/app/src/admin/routes.test.ts apps/app/src/admin/routes-search.test.ts apps/app/src/admin/routes-maintenance.test.ts
pnpm build
```

The final notification supplies the exact committed SHA; this file is part of that commit and cannot self-reference its own hash. Logs and delivery receipts remain in the task-owned validation directory. Receipt means delivered, not approved. Keep this worktree and evidence for parent review; no push/PR/merge/deploy/cleanup.

## Latest-source results

- `pnpm typecheck`: exit 0 (`final-typecheck.log`).
- `pnpm lint`: exit 0 (`final-lint.log`).
- 17-file Vitest command above: 122 passed, 1 timed out; 16 files passed, 1 failed. Existing `pg-runs.test.ts` heartbeat test exceeded its unchanged 20,000 ms timeout at 20,118 ms. No assertions/timeouts/worker settings were weakened. Full identical rerun is recorded separately in `final-tests-retry.log`.
- `pnpm build`: exit 0 (`final-build.log`), Vite chunk-size warning only.
- Admin fixture/new progress test, admin routes/search/maintenance, both stores and manual latest-failed projection tests are included in the 17-file run.
- `git diff --check`: passed.

Retained `final-exits.txt` records command exit codes. Earlier 102-test success predates the admin follow-up and is not presented as validation of the final source.

Final identical 17-file rerun on the same source: **123 passed, 17 files passed**, exit 0, 89.26 seconds (`final-tests-retry.log`). The earlier timeout remains recorded, not erased. Final source gates: typecheck 0, lint 0, tests rerun 0, build 0. These gates preceded the parent navigation follow-up below and are retained as historical evidence. Recommended next step: independent parent review of the local commit and migration safety proposal, then decide integration separately. No remote publication is part of this handoff.

## Main-run navigation follow-up

The parent identified that the expanded main row still toggled the group and lacked a details action. Added an explicit native button with an Arabic/English accessible name that calls `onOpenRun(main.id)` without bubbling to the row. Row keyboard handling now acts only when the row itself is the event target; native nested details/expand/select/retry controls keep their own keyboard activation. A focused `RunGroupRows.test.tsx` checks main identity once, exact main navigation, focus, Enter/Space not intercepted, independent selection/retry/expansion, and direct row keyboard activation. The final source includes this correction; its gates are recorded in the navigation-prefixed logs and final notification.

Navigation verification: `pnpm typecheck` exit 0; focused three-file UI run 21/21 passed. The first focused attempt failed because the new direct-component test omitted QueryClientProvider; the test wrapper was corrected to include the real QueryClientProvider and MemoryRouter. No production logic/assertion weakening was used. Full latest-source gates follow in the final notification and navigation-prefixed logs.

Navigation source parity: all 22 changed source/test/migration files are byte-identical to the E:/Dev validation snapshot (`source-parity.json`). Navigation `pnpm lint` and `pnpm build` both exited 0; build retained the Vite chunk-size warning. The earlier heartbeat timeout and identical successful 17-file retry remain preserved in `final-tests.log` and `final-tests-retry.log`.

**Final navigation source verification:** 18 test files passed, 124 tests passed, exit 0, 59.38 seconds (`nav-final-tests.log`). Final source gate exits: typecheck 0, lint 0, build 0, final tests 0. Original heartbeat timeout 20,118 ms / 20,000 ms and the unchanged successful retry logs are retained. After these gates only the handoff report and a trailing blank line in the new navigation test were normalized; no executable behavior or assertions changed.

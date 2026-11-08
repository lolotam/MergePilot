# Dashboard review progress integration checklist

Architecture and lifecycle semantics: [ADR-0054](adr/0054-dashboard-review-progress.md).
Behavior: [dashboard review progress](dashboard-review-progress.md).
Production operations: [migration safety and rollback](review-progress-migration-safety.md).

## Validation evidence

The initial implementation passed typecheck, lint, build and 124 targeted tests across 18 files. An independent broader regression passed 988 tests across 128 files. An earlier heartbeat timeout at 20,118 ms against an unchanged 20,000 ms limit passed on identical rerun; no timeout or worker configuration was relaxed. The initial PR head also passed CI, PostgreSQL Integration Tests and Bundle Check.

After review fixes, typecheck, lint, build and 32 targeted tests across six files passed. These cover stale recovery, auxiliary persistence failure, workspace deletion, navigation and main-row uniqueness. Exact-head CI and external reviews must cover the final pushed commit before merge. Existing Vite chunk-size advisory remains.

A subsequent accessibility review replaced focusable row activation with native details controls for single, main and sub-run rows. All 59 tests across nine dashboard files passed; source and test files match the validation snapshot. Keyboard focus follows native controls while row clicks remain a pointer convenience.

## Remaining gates

- Verify exact-head required checks and reviews, resolve confirmed findings and coordinate merge order.
- Verify production backup/restore and bounded migration lock acquisition on the approved target.
- Obtain the independent migration/deployment decision for the final release.
- Drain old workers before new workers consume jobs. On rollback keep old workers stopped; old-worker retries do not reset new progress metadata.
- Preserve progress columns/data. Migration-bearing releases require operator failure/HOLD disposition instead of ordinary automatic rollback.

No production migration, rollout or live provider probe is implied by these local validation results. Execution-machine paths, logs and detailed historical receipts remain in the manager's local handoff rather than product documentation.

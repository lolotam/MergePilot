# ADR-0036: Workspace per-review spending limit

**Date:** 2026-10-19 · **Status:** accepted (owner decision س54) · **Amends:** ADR-0019 (workspace defaults)

## Context

Only `.mergepilot.yml` could set `budget.perReviewUsd`, whose engine default is $0.50. The owner requested a dashboard setting integrated with the workspace monthly budget. The implementation brief explicitly keeps $0.50 as the default; $10, mentioned in the owner's verbatim answer, is an editable choice rather than a new default.

## Decision

1. Migration `0015_per_review_usd.sql` adds `workspace_settings.per_review_usd numeric(10,2) NOT NULL DEFAULT 0.50`, checked between $0.50 and $1000. Existing and new workspaces keep the old default.
2. Settings GET returns the stored number. Settings PUT accepts whole cents in that range; omission keeps the stored value. Owners and admins can edit it; members can read it. Both stores and settings backup/restore carry it like the other settings.
3. Validate the resulting pair after merging a PUT with the workspace's stored settings: when `monthlyBudgetUsd` is set, `perReviewUsd` must not exceed it. Changing either side can fail with HTTP 400 `validation_error`, `perReviewUsd must not exceed monthlyBudgetUsd`. Equality is valid; clearing the monthly budget removes the relation. Existing monthly budgets below $0.50 remain stored at migration, but their next settings update must correct the pair or clear the monthly budget.
4. Follow the workspace findings-limit pattern in ADR-0033: the worker passes `perReviewUsd` in `loadRepoConfig` defaults. `parseConfig` fills only an omitted `budget.perReviewUsd` and records it in `defaulted`. An explicit file value wins; invalid file values still fail validation. With no file, the worker uses the workspace value directly. The engine keeps accepting positive repository limits, including below $0.50; the dashboard bounds apply to the workspace setting only. The GitHub Action has no workspace and is unchanged.
5. The review marker hash includes an inherited cap only when it differs from $0.50. Structured hashing combines it with the existing findings limit and skill fields without changing hashes when it is absent or default. A file with an explicit limit keeps its hash when the workspace setting changes. Inheritance does not disable repository pricing for a provider/model the file itself names.
6. Admission already uses the effective `budget.perReviewUsd` per paid bot, so a $10 monthly budget with two paid bots at $3 reserves $6. Preserve ADR-0022's original admission predicate, ADR-0033's subscription pin, and ADR-0035's two-pass paid-fallback reservations. This does not introduce a stricter fit check for ordinary paid bots. Repository overrides may exceed the workspace monthly budget; admission still follows those existing rules.
7. The dashboard puts a number input next to the monthly budget, with min $0.50, max $1000, step $0.50 and default $0.50. Typed whole-cent amounts are valid. Client validation mirrors the API bounds, cents, and monthly relation. Arabic and English hints explain the per-bot API cap, subscription exemption, reservation and repository override.

## Consequences

- Owners can choose $10 or another cap without editing every repository. Repositories copied from examples that explicitly set the cap keep that value until it is removed or edited.
- API-key spending stays under the existing engine budget checks. Subscription reviews remain zero incremental API cost and unaffected by this cap; dual-method and configured fallback accounting is unchanged.
- Changing an inherited non-default cap makes the next review full, while deployment at the default preserves existing markers.
- Monthly admission remains in memory per worker process. This setting does not change concurrency or introduce shared reservations.

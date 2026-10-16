# ADR-0024: API-equivalent cost of subscription and token-plan runs

**Date:** 2026-10-14 · **Status:** accepted · **Owner decision:** decisions log س39

## Context

A run on a connected consumer subscription (OpenAI/Codex, Anthropic/Claude, xAI/Grok) reports its token usage with a real cost of $0, because the subscription is a flat fee (ADR-0020 amendment to ADR-0016). A run on a flat-rate token plan such as `zai-coding` is $0 for the same reason: the catalog prices the plan at 0. The runs table therefore showed `$0.0000` for most of the owner's bots, which hid what the reviews consume and what the subscriptions save.

The owner asked for the figure the tokens would have cost at the API price, and decided it must stay **separate**: shown as an equivalent, never counted as money spent (the monthly budget of ADR-0014 stops reviews on real spend) and never in the GitHub review summary.

## Decision

1. **A display-only figure inside the run record.** `result.pricing` gains `apiEquivalentUsd` and `apiEquivalentSource` (`apps/app/src/core/price-types.ts`). The `review_runs.cost_usd` column, `workspace_usage_monthly`, the group sums, the budget admission and `renderReviewSummary` never read `result.pricing`, so they are untouched by construction. No migration.
2. **Computed in the worker from the review model's own usage** (`apps/app/src/worker/api-equivalent.ts`, used by `recordOf` in `review-bot.ts`): `costUsd(usage, apiPrice)` over the full `TokenUsage` of the completed run, before the judge's tokens are folded into the stored usage. Jev's cost is real and already in `cost_usd`.
3. **Which price:**
   - a subscription model: the workspace's manual price, then the catalog row of the same provider and model (subscription credentials use the plain provider ids, so no mapping is needed). Never the repository's `budget.pricing`: a repo file must not set what the dashboard shows as the subscription's savings;
   - a token plan whose catalog price is a known $0: the same model under its plain API provider (`zai-coding` → `zai`), workspace manual price first, then the catalog. A plan the catalog prices above $0 is charged for real, and an unpriced plan has no real cost to compare with: neither gets an equivalent.
4. **Absent, never $0.** When no source knows the API price (a subscription model id the catalog does not list), the fields are left out and the dashboard shows nothing: a `$0 ≈` would recreate the confusion this ADR removes.
5. **Equivalent only when every review call used the subscription** (ADR-0027). A method fallback to API keys or a configured model fallback hides the equivalent, even when the labels match.
6. **Subscription runs record `source: 'subscription'`** instead of `'static'` (which also names the judge's built-in Jev table). The prices card labels subscription models the same way. The dashboard contract's `PricingSourceSchema` is a plain string, so older clients are unaffected.
7. **Dashboard:** the runs table shows `≈ $x` under the cost of a run and under a PR group's summed cost (`RunCostCell`), and the run detail shows `≈ $x API-equivalent · <price source>` under the cost, naming where that API price came from. The group figure follows the `costUsd` sum semantics: null when no run has one. The Overview totals and the admin pages are unchanged.

## Consequences

- The owner can see per run and per PR what the subscriptions save; the budget keeps counting real money only, so no review is stopped over a notional figure.
- The list and detail routes gain one nullable field each (`apiEquivalentUsd` on `ReviewRun` and `RunGroup`), projected from `result.pricing` by `toRunDto` / `toRunGroupDto`; no store or SQL change, and no sorting by the equivalent.
- `xiaomi-token-plan*` and any future flat-rate plan need one entry in `TOKEN_PLAN_API_PROVIDER` to get an equivalent; until then they show $0 as before.
- Docs that stated the old rule are amended: ADR-0016 (amendment line and token plans), ADR-0020, `docs/subscription-auth.md`, `AGENTS.md` and the prices card note.

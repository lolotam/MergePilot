# ADR-0047: API-equivalent usage card for subscriptions and coding plans

**Date:** 2026-10-25 · **Status:** accepted · **Owner decision:** decisions log س60

## Context

ADR-0024 records, per run, what the tokens of a subscription or flat-rate token-plan run would have cost at the API price (`result.pricing.apiEquivalentUsd`), and the runs table shows it as `≈ $x`. Nothing adds these figures up, so the owner cannot see what the subscriptions and coding plans are worth in API money, or what a review would cost if he moved it to API keys. A run that switched between a subscription and an API key in the middle (ADR-0027) gets no equivalent at all, because the run does not record which calls ran on the subscription.

## Decision

1. **A second card on the Overview page,** next to «Usage this month». It shows the subscription and coding-plan usage priced as API: the current month, the total of every retained run, the average per review, and a split by provider and model (tokens and the API-equivalent amount). It says it is an estimate for display, and how many runs were left out because their price is unknown. **It is never part of the monthly budget, `cost_usd`, the spend caps or the GitHub summary.** The existing card keeps showing the real API spend only.
2. **What counts:** runs on a consumer subscription (OpenAI/Codex, Anthropic/Claude, xAI/Grok, Google Antigravity) and on flat-rate coding plans the catalog prices at $0 (`zai-coding` → `zai`, `minimax-coding-plan` → `minimax`), priced as in ADR-0024 (workspace manual price, then the catalog; never the repository's `budget.pricing`).
3. **Mixed runs count their subscription part only.** `FallbackChain` records the token usage of every call answered by a subscription-backed model, by model label, and discloses it (`subscriptionUsage`). The worker prices each entry at its own API price and stores it as `result.pricing.subscriptionPart` (`{ usd, byModel, source }`), apart from `apiEquivalentUsd`: the runs table keeps showing `≈ $x` only for a run whose every call stayed on its own subscription model (ADR-0024 §5, ADR-0027 §7), so a mixed or fallback run shows no equivalent there and is counted on this card only. A run that switched from the subscription to API keys before the subscription answered any call stores an empty part (`{ usd: 0, byModel: [] }`), which the card neither counts nor leaves out; a run that failed before any call has no usage and is skipped the same way. If any subscription call has no known API price, `subscriptionPart` is `null` and the card leaves the whole run out rather than count part of it. A run that stayed on its own subscription model is priced as before; the API-key calls of a mixed run stay in the real cost only.
4. **Older runs, without breaking anything:** a run that already has `apiEquivalentUsd` keeps the figure recorded when it ran. A run without it, priced `subscription` (or `static` at $0, as subscription runs were recorded before ADR-0024) or on a token-plan provider, is priced at query time from its stored tokens (judge tokens taken out) at today's API price. Runs store only input and output tokens, so such a figure leaves out cache tokens and is a lower bound. An older run that switched methods in either direction (`result.fallbackFromMethod` set, no `subscriptionPart`) cannot be split, so it is left out and counted in «left out», as is a run whose model has no known API price. Nothing is written to the database: the card is computed when it is read.
5. **API.** `GET /api/workspaces/:workspaceId/usage/api-equivalent` (member) answers `{ monthUsd, totalUsd, reviews, averagePerReviewUsd, leftOut, byModel: [{ provider, model, inputTokens, outputTokens, usd }] , monthStart }`. The existing `/usage` answer is unchanged.

## Consequences

- The owner sees, per month and in total, what the subscriptions and coding plans would cost as API, and what one review costs on average.
- «Total» covers the runs the retention policy (ADR-0014) still keeps, not runs it already deleted.
- New runs on a mixed method or a model fallback between subscriptions now get an equivalent where they had none.
- No migration and no backfill write; prices are today's for older runs that never stored one.

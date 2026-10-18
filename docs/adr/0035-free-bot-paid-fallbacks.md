# ADR-0035: A free bot and its paid fallbacks on other providers

**Date:** 2026-10-18 | **Status:** Accepted (owner decision س52) | **Amends:** ADR-0033, ADR-0022 (admission)

## Context

Under a monthly budget, `processReviewJob` admits every bot of a review before any of them runs (ADR-0022). `reviewUsesSubscriptionAdmission` (`apps/app/src/worker/dual-method-review.ts`) reads one provider per bot: `mainChoice.provider` for slot 1, `bot.provider` for an extra bot. A bot is **free** when that provider is a subscription default with no API keys. A free bot reserves $0, and ADR-0033 pins it to that subscription for the whole run.

The bot's configured ADR-0008 fallbacks are never read by admission. Slot 1 uses `settings.fallback`, and an extra bot uses its own `bot.fallback`. In `runBot`:

- `withinAdmission` removes the primary provider's dual entry, and every dual entry whose default is the subscription. A fallback provider whose default is API keys keeps its entry.
- `loadRosters` loads the API key roster of every fallback provider whose effective method is `api-key`. Only the primary provider is excluded.
- `resolveFallbacks` (engine) builds those entries as paid API-key models.

A free bot whose subscription fails with quota, rate limit, auth, a server or a network error (the ADR-0008 triggers) therefore continues on a paid fallback that no reservation covers. ADR-0033 lists this as not covered.

A **paid fallback** here is a configured fallback entry on another provider for which `reviewUsesSubscriptionAdmission` returns false. That covers an API-key default, a subscription default that also has API keys, a provider whose state cannot be read, and `custom`. A fallback on the bot's own provider is already pinned to the subscription by ADR-0033 and is free.

The owner already answered a close question in س42 (ADR-0027). When a subscription runs out and the review continues on API keys, the cost is counted and shown. ADR-0027 made a subscription bot that also has API keys reserve like a paid bot.

## Options

- **(a) Reserve.** Admission counts a bot as paid when its own provider or any of its configured fallback providers is paid. Such a bot reserves `perReviewUsd`, `admittedFree` stays false, and the run follows the live state, like any paid bot (ADR-0033 §5). The fallback runs when the subscription fails, and its cost is counted, as in س42.
  - Cost: the bot reserves on every review, although it usually runs free on the subscription. Near the monthly limit, fewer reviews are admitted. When the reservation does not fit, the whole review is skipped (admission is per review), although the subscription alone could have run it.
  - Change: `process-review.ts` admission reads `[provider, ...fallbackChain(...).map(f => f.provider)]` for each bot, once per provider.
- **(b) Skip.** A bot admitted free skips its paid fallbacks. Each one is disclosed in `skippedFallbacks` with the reason "the review was admitted free under the monthly budget". When the subscription fails, the bot fails with that error, or a free fallback answers.
  - Cost: with a monthly budget set, a configured paid fallback never runs behind a subscription bot, even with money left in the budget. This is the opposite of س42.
  - Change: a generic skip predicate in `CreateReviewModelOptions`, applied in `resolveFallbacks`. The engine stays unaware of budgets. `runBot` also leaves the paid providers out of `loadRosters` and `customBaseUrlFor`.
- **(c) Both.** Admission first tries (a). When the reservation does not fit, it admits again without these bots, and they run as in (b). The fallback runs while the budget has room, and the review still runs near the limit. Cost: two admission passes and both code paths.

A top-up during the run is not offered: ADR-0033 already rejected a second admission while a review runs.

## Decision

**(c) Both**, as the owner answered verbatim: «MP-1.5 ج» (س52).

Snapshot admission eligibility once per provider across the review. First reserve `perReviewUsd` for each bot whose own provider or any configured fallback on another provider is paid. Those paid admissions have `admittedFree=false` and follow live state (ADR-0033).

If this does not fit, retry with subscription-only primary bots admitted free, reserving only for the paid-primary bots. Free bots skip their paid fallback providers from the snapshot. Own-provider fallbacks stay pinned to the subscription (ADR-0033). Each skipped entry is disclosed with `skipped: the review was admitted free under the monthly budget`. A generic skip predicate in the engine excludes these entries from model construction; their credentials and key rosters are still loaded for redaction only. The worker never passes those rosters to the model factory and does not load their custom base URL.

Admission keeps ADR-0022's original predicate for ordinary paid bots. Define:

- `base = perReviewUsd` times the number of bots paid on their own provider.
- `extra = perReviewUsd` times the number of free-primary bots with paid fallbacks on other providers.
- `spent` is the current monthly spend; `reservedUsd` is what other admitted reviews hold.

Pass one reserves `base + extra`. Its predicate is `spent + reservedUsd < budget`, plus `spent + reservedUsd + base + extra <= budget` **only when `extra > 0`**. Equality is allowed for this additional fit check.

Only when `extra > 0` and pass one fails, pass two reserves `base` with **exactly** the original predicate: `spent + reservedUsd < budget`. The affected free-primary bots skip their paid fallbacks. The base reservation is not subject to the additional fit check on pass two. With `extra == 0`, there is just one pass, reserving `base` with the original predicate, identical to the existing behaviour. For example, a normal paid bot reserving $1 at $9.50 spent of a $10 budget is still admitted; a free bot with a paid fallback at that point retries free instead.

Both passes use the existing per-workspace serialized queue. Pass two takes a new turn, behind reviews already waiting. All bots are admitted before any runs, in their existing order. If both passes fail, the existing whole-review budget skip is unchanged. No top-up happens during execution.

## Consequences

- Paid fallbacks remain available when the reservation fits. Near the monthly limit, subscription-only bots can still run with paid fallbacks explicitly excluded.
- Paid-primary bots keep the original admission predicate and base reservation, including on pass two. This decision does not tighten admission for ordinary paid reviews.
- A subscription failure remains the bot's error unless an allowed free fallback answers.
- Existing accounting is preserved: API calls consume the per-review spend limit; method-only fallback costs remain known; configured model fallback costs remain unknown under ADR-0008, retaining tokens and disclosure. No invented dollar price is recorded.
- Eligibility is read once per provider for both passes. Paid admissions follow live state; free primaries keep ADR-0033's subscription pin.
- Every allowed fallback provider of a free-admitted bot is also pinned to its subscription for the whole run: later API keys or default changes cannot make it paid, and a replaced subscription fails with `INVALID_CREDENTIAL` instead of using a key.
- Without a monthly budget there is no admission and nothing changes.

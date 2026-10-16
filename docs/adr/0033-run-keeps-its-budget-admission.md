# ADR-0033: A run keeps its budget admission — a free bot stays on its subscription

**Date:** 2026-10-16 · **Status:** accepted · **Amends:** ADR-0022 (admission), ADR-0027 §7 (admission)

## Context

Under a monthly budget, `processReviewJob` admits every bot of a review before any of them runs (ADR-0022). `reviewUsesSubscriptionAdmission` (`apps/app/src/worker/dual-method-review.ts`) decides per bot:
- **Free:** a subscription default with no API keys. The bot reserves $0.
- **Paid:** anything else. The bot reserves `perReviewUsd`.

`runBot` (`apps/app/src/worker/review-bot.ts`) builds the model later and read the credential state again. ADR-0027 Phase B added `BotRun.admittedFree`, so API keys connected after admission did not become a paid fallback behind a free bot's subscription. Three gaps were left:

1. **The default switched to API keys.** An admin switched the default method between admission and the model build. `runBot` saw `api-key`, used the key roster, and the bot ran on API keys that no reservation covered.
2. **The subscription was replaced by an API key.** The same race existed before ADR-0027: `runBot` built the primary from whatever the parent row now held, and the run paid.
3. **The default switched during the run.** The worker credential store asked for the effective default again on every resolve. A subscription model resolves before each call to refresh its token, so after a switch it received a key. The subscription adapter rejects a key, so the call failed as `auth` although the subscription was still connected.

A fourth gap was in admission itself, and it is fixed here because the pin needs the right provider. Slot 1 runs on `mainChoice`, which is the heavy-duty provider for a large PR (ADR-0017), but admission checked `bot.provider`, the light model's provider. A free light provider could admit a paid heavy-duty run.

## Options

- **Top up the reservation** through `BudgetAdmission` before a paid path. This needs a second admission while the review runs, and a way to handle a refused top-up after some calls are already made.
- **Pin the admitted method.** `admittedFree` already records the decision. This option only makes the build and the store follow it.

## Decision

The pin. A bot admitted free (`BotRun.admittedFree`) runs its own provider on the subscription it was admitted with, until the run ends.

1. **The primary.** `runBot` reads the parent row through `admittedSubscription` and never through the effective default or the key roster. The parent must decode as that provider's subscription envelope. If it does not (the subscription was replaced by a key), the bot fails with `LlmFailure` `INVALID_CREDENTIAL`. The message says the subscription is no longer connected and that the review was not run on API keys outside the monthly budget. The message never contains a credential. Only that bot's run fails. The review was admitted free, so it is never paid for with keys.
2. **The store.** `WorkspaceCredentialStore` takes `{ subscriptionOnly: true }` for such a bot. Every resolve for the primary provider then goes through `admittedSubscription`: a plain resolve, a resolve by method, and the refresh before each call. A switch during the run therefore changes nothing. A removal during the run fails the next call as an `auth` failure, which goes to configured fallbacks under the ADR-0008 triggers. Other providers resolve as before.
3. **No key path for that provider.**
   - `withinAdmission(dualMethods, admittedFree, primaryProvider)` drops the bot's own provider from the method fallback, whatever its default is now. It still drops every subscription-default entry, as in ADR-0027.
   - `runBot` loads no key roster for that provider. Without this, the engine would build the primary, or a configured fallback on the same provider, as a rotating API-key model.
4. **Admission on the provider that runs.** Slot 1 is admitted on `mainChoice.provider`, so a large PR on a paid heavy-duty provider reserves `perReviewUsd`.
5. **Paid bots are unchanged.** A bot that reserved `perReviewUsd` may follow the live state. Any method stays inside the per-review budget it holds.
6. **Without a monthly budget** there is no admission and nothing to keep. `admittedFree` stays unset and the run follows the live state, as before.

## Consequences

- An admin who switches the default to API keys during a review sees that review finish on the subscription. The next review uses the new default.
- A subscription removed between admission and the end of the run fails that bot clearly, instead of a silent paid run.
- Not covered: configured ADR-0008 fallbacks to **other** providers behind a free bot. ADR-0022 never counted them in admission. A free bot whose subscription fails can still reach a paid fallback on another provider. This needs its own decision: either reserve for such bots, or skip paid fallbacks and disclose the skip.
- Tests: `process-review-dual-method.test.ts` changes the state between admission and the model build. It covers a switched default, a replaced subscription and the heavy-duty provider. `workspace-credential-store.test.ts` covers the pinned store under `createReviewModel`.

# ADR-0027: Subscription and API keys together, with a default method and a disclosed method fallback

**Date:** 2026-10-15 · **Status:** accepted · **Owner decision:** decisions log س42

## Context

`anthropic`, `openai` and `xai` accept a consumer subscription (Claude, Codex, Grok; ADR-0020) or an API key. Until now a workspace stored exactly one of them: the single `provider_credentials` row held either the subscription envelope or the key, and saving one replaced the other. ADR-0026 added ordered lists of up to 20 API keys, but only for `gemini`, `openrouter` and `opencode-zen`.

The owner asked that these three providers keep a subscription **and** up to 20 API keys at the same time, choose the default method, and continue with the other method when the default runs out. The owner's decisions (س42):
- Both methods together, with a selectable default.
- A paid API-key fallback is counted in the monthly budget and disclosed in the GitHub review and the dashboard.
- The switch happens only on quota or rate limit.
- Both directions: subscription → API keys and API keys → subscription.

## Decision

The change is delivered in two phases, each in its own pull request:
- **Phase A:** points 1, 2, 3, 8 and 9. Both methods coexist and the default is stored, but a review still uses only the effective default method. Migration `0012` only adds a table.
- **Phase B:** points 4–7, the money and runtime change: the method fallback, its triggers, its disclosure, its cost and budget admission.

1. **Scope.** `DUAL_METHOD_PROVIDER_IDS = ['anthropic', 'openai', 'xai']`, which is the same set as `SUBSCRIPTION_PROVIDERS`. For these providers the API keys use the ADR-0026 machinery: the `provider_api_keys` slots, the key cursor, the 20-key cap, rotation and per-key tests. Every other provider is unchanged.

2. **Storage.**
   - **The parent row.** The subscription envelope stays in the parent `provider_credentials` row. When a subscription is connected, the parent row is the subscription and the API keys live only in slots. The ADR-0026 mirror ("parent = slot 0") applies only while no subscription is connected.
   - **The locked change sees the parent.** `modifyProviderKeys` reads the parent row in the same transaction and lock, and passes it to the change: `change(currentSlots, parent)`. Both stores and the store contract follow this. The service decrypts the parent and uses `decodeSubscription` to tell a subscription from a key. No store method that opens a second connection may be called inside the change.
   - **Every slot write follows that rule:**
     - `saveKey`, and `PUT /keys/:provider` with one `apiKey` or a list of `apiKeys`: replace the key list and keep a subscription parent
     - append, delete, reorder
     - subscription connect and disconnect
     - backup restore
     - master-key rotation (`vault/rotate.ts`)

     When the parent is a subscription it is kept. When the parent is an API key, the ADR-0026 mirror applies.
   - **Legacy materialisation.** Under the lock, a dual provider whose parent is an API key and which has no slots first gets that parent inserted as slot 0. This happens before the first key append and before a subscription is connected, so neither path loses the existing key. SQL cannot do this as a migration, because it cannot tell an encrypted key from an encrypted envelope.
   - **The roster never contains the envelope.** For a dual provider, `resolveKeyRoster` and `revealRoster` return the parent-only one-key roster only when the decrypted parent is not a subscription envelope. A subscription parent with no slots means there are no API keys (`null`).
   - **Connecting a subscription** writes the envelope as the parent and never deletes slots.
   - **Disconnecting the subscription** (new route) rewrites the parent from slot 0, or deletes the parent when there are no slots.
   - **Deleting the last API key** keeps a subscription parent.
   - **`DELETE /keys/:provider`** still removes everything for that provider, including the default-method preference.
   - **Default method.** Migration `0012_provider_auth_preferences.sql` adds the table `provider_auth_preferences`:
     - `workspace_id`, `provider`, `default_method` (`CHECK IN ('subscription', 'api-key')`), `updated_at`
     - `PRIMARY KEY (workspace_id, provider)`
     - deleted with the workspace in both stores
     - written under the credential lock

3. **Effective default.** The effective default is the stored preference when that method has a credential, otherwise whichever method exists. With no preference row it is `subscription` when one is connected, otherwise `api-key`, which is the behaviour before this ADR. Setting a method that has no credential is refused. The keys list, the runtime and budget admission all use the effective default, never the parent row's prefix.
   - In Phase A a review uses only that method. A subscription default uses the subscription. An API-key default uses the rotating key list (ADR-0026) even when a subscription is connected.

4. **The method fallback (Phase B).** When a dual provider has both methods, the model built for it is the effective default. It is followed **immediately** in the fallback chain by the same provider and model on the other method:
   - an API-key rotating model behind a subscription default;
   - a subscription model behind an API-key default.

   The chain is `[primary, primary-other-method, fallback1, fallback1-other-method, …]`. The configured ADR-0008 fallbacks are unchanged. The subscription model keeps its resolver, so a token refresh still happens mid-review. It asks the store for the subscription by name (`CredentialRef.method: 'subscription'`), because a plain `resolve` answers with the effective default, which is an API key when keys are the default. An other-method entry that cannot be built is listed in `skippedFallbacks` with a fixed reason, never dropped silently.

5. **Triggers, with skip semantics (Phase B).** A method-fallback entry is entered only for failure kinds `quota` and `rate-limit`. That includes `QUOTA_EXHAUSTED_ALL_KEYS`, whose kind is `quota`.
   - `ReviewModel` gains an optional `fallbackTriggers`. `FallbackChain` skips an entry whose triggers do not include the failure kind, and looks at the next entry with the global ADR-0008 triggers.
   - The recorded `fallbackFrom` stays the primary's failure.
   - Example: a subscription that fails with `auth` while keys exist goes to the configured fallback, and the keys are not used. An expired subscription is never silently paid for.

6. **Disclosure (Phase B).** `ReviewModel` gains `authMethod?: 'subscription' | 'api-key'`, and `rotatingReviewModel` keeps `authMethod` and `includedInSubscription` of the method it wraps.
   - The disclosure adds `fallbackFromMethod` and `modelUsedMethod` only when the model that answered is the primary's own model on another method, because the `provider:model` labels are equal then. A configured model that answered after the other method also failed is disclosed as an ordinary ADR-0008 fallback.
   - **GitHub summary:** the fallback notice says the review continued with an API key (or with the subscription) because the other method hit its quota or rate limit.
   - **Dashboard:** the run record stores the method switch in its existing `result` JSON, next to `fallback_from`. No new column.
   - **Logs:** carry the methods and the failure kind, never a secret.

7. **Cost and budget (Phase B).**
   - **Pricing.** For a dual provider, `budget.pricing` is always the model's **API** price, whatever the default. It comes from the ADR-0024 lookup: the workspace manual price, then the catalog row of the same provider and model. Subscription calls stay $0 through `includedInSubscription`, and API-key calls are priced with the API price.
   - **Final cost.** A run whose only fallback is a method fallback records `cost_usd` as the sum of its priced calls. This is identified by the disclosure: `fallbackFromMethod` is set and the `modelUsed` label equals `fallbackFrom`. A run that used a configured model fallback keeps the ADR-0008 §4 "unknown after fallback" rule.
   - **Admission.** A subscription-default bot whose provider also has API keys reserves `perReviewUsd` like a paid bot (ADR-0022), because it may pay. `reviewUsesSubscriptionAdmission` (`apps/app/src/worker/dual-method-review.ts`) decides from the effective default and the key list, not from `resolve()`; a state that cannot be read counts as paid. A bot admitted as free keeps that decision for its run: API keys connected after admission do not become a paid fallback behind its subscription until the next review.
   - **Budget at the switch.** The switch from the subscription to paid keys happens inside one call, after that call's budget check ran at the subscription's $0 price. The chain therefore prices the call at the API price first; when it does not fit what is left of `perReviewUsd`, the keys are not entered and the chain goes on as if they were absent: to the next configured fallback (ADR-0008), or the review fails with the subscription's error.
   - **API-equivalent.** The ADR-0024 figure is shown only when every call was on the subscription.

8. **API and dashboard.**
   - **Keys list.** For a dual provider it reports `hasSubscription`, `defaultMethod` (the effective default) and its `keys` slots. `authMethod` keeps meaning the effective default, for older clients.
   - **New routes** (admin only, workspace scoped, rate-limited like the other credential routes):
     - `PUT /api/workspaces/:ws/keys/:provider/default-method` with `{ method }`
     - `DELETE /api/workspaces/:ws/keys/:provider/subscription`
   - **Slot routes** (ADR-0026) accept dual providers.
   - **Add-key form.** For a dual provider it offers both subscription sign-in and the + list of API keys with a per-key Test. Saving one does not replace the other.
   - **Settings row.** Shows both methods and a default selector.
   - **Text.** All user-facing text is in the en and ar dictionaries. The "this replaces the current credential" copy is removed.

9. **Backup** (ADR-0018). Export carries the sealed subscription envelope, the sealed key list and the **effective** default method (not only a stored preference row). Restore applies each dual provider as one locked change inside the same restore transaction, so a failed restore still changes nothing (ADR-0018): a file with a subscription envelope sets the parent to that envelope and keeps the file's key slots when present, otherwise the current slots after legacy materialisation; a keys-only file replaces the slots and keeps a subscription parent when one is connected, otherwise mirrors slot 0; the preference row is set from `defaultMethod` or deleted when the field is absent. The file wins over an unreadable current credential, so a restore can still repair a workspace after a lost master key. Subscription envelopes inside the key list are rejected. Non-dual providers and backups from before ADR-0027 restore unchanged.

## Amendment (2026-10-17): a failed run keeps its spend and its method switch

Until this amendment a run that ended `failed` stored `cost_usd: null` and `result: null`, even when it had already paid for API calls. The monthly spend missed that money, and the dashboard could not show a fallback or method switch that happened before the failure. The gap was older than this ADR and applied to every provider.

1. **Engine.** A failed `ReviewRunResult` carries `usage`, `costUsd` and `onlySubscriptionCalls`, next to the fallback disclosure it already had.
   - `costUsd` follows the point 7 rules for a completed run, from one shared function (`knownCostUsd` in `pipeline.ts`): $0 when every call was on a subscription, the tracked spend after no fallback or a method-only fallback, and unknown (absent) after a configured model fallback.
   - The tracked spend is the same `SpendTracker` total a completed run uses. It holds the real cost where usage was reported, and the estimate for a retry or batch that threw (ADR-0011).
   - `usage` sums the calls that answered. A failure on the first call has none.
   - A priced review that fails on its first whole-PR call, before any answer, now records a known `cost_usd: 0` instead of null, because the tracker charged nothing. (A thrown batch or retry is charged at its estimate, as above.) `null` keeps meaning an unknown cost: after a configured model fallback, without pricing, or outside the engine (point 5).
2. **Worker.** `executeReview` and `reviewOnlyOutcome` pass the failed run's `costUsd` on, and `recordOf` stores it in `cost_usd`.
   - `recordOf` also stores a reduced `result` for the failed run: `v: 1`, with an empty `summary`, `highlights` and `findings`, plus the run language, `usage`, `pricing` (with the ADR-0024 API-equivalent when every call was on the subscription), the method switch and the key rotation. It holds no provider text or model answer. The redacted error stays in `detail`, and the answers without JSON stay in the logs.
   - `findings_count` stays null.
   - The subscription price record uses the engine's tally, like a completed run.
3. **Spend.** `workspace_usage_monthly` already summed `cost_usd` and `result.usage` for every finished status, so a failed run's spend and tokens now count toward `monthCostUsd`, the budget admission (ADR-0022) and the group sums. A retry of the same job reuses the failed row, and each attempt still counts once (ADR-0014).
4. **API and dashboard.** The run's `result` schema is unchanged; a failed run's payload is the reduced shape above.
   - The runs list reports `severityCounts: null` for a failed run.
   - The run detail page shows the cost, the tokens and the method notice of a failed run, plus one line (en and ar) saying the cost is for the calls made before the failure and is counted in the monthly budget. The summary and findings cards stay hidden.
5. **Not covered.** A run failed by `failBotRun` (a worker exception outside the engine, or a consensus publish that failed after the reviews) and a run failed by the stale-run sweep still record `cost_usd: null`. Neither one has the engine's spend.

## Consequences

- AGENTS.md "one active credential per provider; saving either method replaces the other" now has an exception for these three providers. ADR-0020 (one credential, replacement), ADR-0026 (scope and the parent mirror) and `docs/subscription-auth.md` are amended to point here.
- ADR-0008 §4 is narrowed: a method-only fallback has a known cost.
- ADR-0022 is narrowed: a subscription bot that may fall back to paid keys reserves its per-review budget.
- An expired or revoked subscription (auth failure) is not hidden by paying with keys.

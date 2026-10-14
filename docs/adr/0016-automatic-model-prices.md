# ADR-0016: Automatic Model Prices From Public Price Lists

- **Status:** Accepted (2026-10-13)
- **Related to:** ADR-0008, ADR-0014, ADR-0015, docs/decisions.ar.md (batch 10, Q29)

**Amendment — ADR-0020:** a connected consumer subscription overrides API-token price estimates with zero incremental API cost and records `source: 'subscription'` (`'static'` before ADR-0024) and, when the model's API price is known, a display-only `apiEquivalentUsd` (ADR-0024). Its token usage remains recorded. API-key, judge, and unknown-cost-after-fallback rules below remain applicable to those calls.

## Context

In the SaaS, a run's cost was known only when the repo's `.mergepilot.yml` gave `budget.pricing`
for the exact provider and model the workspace runs (ADR-0008 §4 forbids inventing prices). Almost
no repo does, so almost every run showed cost "—", and the monthly budget (ADR-0014) never counted
anything. The owner asked to fetch prices automatically from the providers that publish them.

## Decision

1. **Sources.** Three public lists, each at a fixed constant URL
   (`packages/engine/src/pricing/sources.ts`):

   | our provider id(s) | source | URL | unit |
   |---|---|---|---|
   | `openrouter` (review and judge) | OpenRouter | `https://openrouter.ai/api/v1/models` | USD per token, decimal strings |
   | `vercel-gateway` (judge only) | Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1/models` | USD per token, strings |
   | every other provider with a mapping | models.dev | `https://models.dev/api.json` | USD per MTok, numbers |

   - **Why models.dev.** Anthropic, OpenAI, Google, xAI, DeepSeek, NVIDIA, OpenCode, Z.ai and
     Xiaomi have no machine-readable price API. models.dev is an open catalog that lists them, and
     one small editable table (`MODELS_DEV_PROVIDER_KEYS`) maps our ids to its provider keys.
   - **No source.** `custom`, `claude-code` and the judge's `typesafe` have none; only a manual
     price applies to them.
   - **Untrusted data.** Every price must be a finite number from 0 to 1000 USD per MTok, or the
     model is dropped. OpenRouter's `"-1"` (dynamic or router pricing) is dropped, so that model
     stays unknown; `:free` ids are kept at 0. A list that parses to no entries counts as a failed
     fetch.
   - **Tiers ignored.** models.dev `tiers` and `context_over_200k` are ignored: the base price
     applies. Long-context requests are therefore slightly underpriced.
   - **Token plans.** Plans such as `zai-coding-plan` and `xiaomi-token-plan-*` are priced at 0 by
     the catalog. A run on them costs $0, which is what the customer pays per token; since ADR-0024 it also records what the tokens would cost at the plain API price, for display only.
2. **Fetching.**
   - **Requests.** Plain GETs to the fixed URLs. No key, cookie or auth header is ever sent.
   - **Limits.** Each source has a 30 s timeout that covers the body too, and a 25 MB body cap
     enforced while reading.
   - **Independence.** The sources are fetched in parallel; one failing never affects the others.
   - **Errors.** They are short fixed strings (`HTTP 503`, `timeout`, `response too large`,
     `invalid JSON`, `no prices found`), never a response body.
3. **Storage.** Migration 0008 adds `model_prices`, one row per `(provider, model)` with its
   source and `fetched_at`.
   - **Replacing.** `replaceModelPrices(source, …)` runs only for a source that fetched OK. In one
     transaction it upserts the source's rows and deletes the source's rows it no longer lists.
   - **Stale data.** When a refresh fails, the stored rows are kept, and the run is recorded with
     the error.
   - **Lookups.** An exact `(provider, model)` match first, then a case-insensitive one.
4. **Refresh job.** `refresh-model-prices` runs on the existing `maintenance` queue daily at 02:30
   UTC.
   - **At startup.** The worker queues it once when the table is empty or the newest `fetched_at`
     is older than 24 h.
   - **Lease and record.** It takes the same lease as retention (ADR-0014), with kind
     `refresh-prices`. The run records the number of stored prices in `deleted_count`, plus any
     per-source error.
   - **Log.** One `prices.refresh` line with ok, count and ms per source.
   - **Manual run.** Platform admins can run it with `POST /api/admin/maintenance/refresh-prices`
     (202, or 409 while it runs). `GET /api/admin/maintenance` shows its last run.
5. **Resolution order for a run's primary model** (`resolvePricing`):
   1. the workspace's manual price (`workspace_settings.price_overrides`, at most 50, admins only);
   2. the repo's `budget.pricing` when the repo file names the same provider and model (the old
      rule);
   3. the `model_prices` row;
   4. otherwise unknown: no `budget.pricing`, so the cost stays `null`, never `$0`.

   The result is the effective `budget.pricing`. The run records it as `result.pricing =
   {source: 'override' | 'repo' | 'catalog:<source>' | 'unknown', inputPerMTok, outputPerMTok,
   fetchedAt?}`. A missing cache price is priced like input tokens, as in the config file.
6. **Judge (ADR-0015).** The worker reads the prices of the judge chain once per review and passes
   a lookup to the judge: the manual price, then the catalog row, then the static Jev table as the
   last resort. A cost the provider reports (Vercel) still wins.
   - **OpenRouter Jev.** OpenRouter's public list does not include the Jev ids. Its per-model
     endpoint gives `typesafe/jev-1.13` at 0.042 USD/MTok input (0 output), and
     `~typesafe/jev-latest` is an alias for it. Both now carry that static price.
7. **Prices route.** `GET /api/workspaces/:id/prices` (members) lists every model the workspace
   uses: primary, heavy, fallbacks, and the enabled judge and its fallbacks. Each row has its role,
   price, source, `fetchedAt` and `overridden`. The route also gives each catalog source's last
   fetch time.

## Consequences

- **Budget behaviour change.** With prices known, the existing per-review preflight
  (`budget.perReviewUsd`, default 0.5 USD) starts to apply in the SaaS. A huge PR on an expensive
  model can be skipped before any model call, and is disclosed as `skipped-budget`. This is
  intended. The monthly budget now counts real costs.
- **Fallback runs.** A run answered by a fallback model still has an unknown cost (ADR-0008 §4).
  The recorded price is the primary model's.
- **Catalog accuracy.** The catalogs can be wrong or late. A workspace admin can correct any model
  with a manual price, and a manual price always wins.
- **Data protection.** The fetch sends nothing about the customer, and the response is never logged.

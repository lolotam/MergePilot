# OpenAI API reasoning correction: impact and local verification

Date: 2026-11-14. Status: local, uncommitted implementation; not published or deployed.

## Authorization and base

The owner authorized code review/correction and a report before any settings change. This patch makes no operational settings changes. It does not change saved models, efforts, prices, credentials, budgets, subscriptions, dispatch, databases, migrations, or production. No real model or Test Connection request was made. No commit, push, PR, merge, deployment, or sub-agent was created.

The prepared worktree initially had HEAD `e88a214835dd1a0ec02f2c8092726d3a16187fdd`, five commits behind the required base. Work stopped and the parent was notified. Following explicit authorization, a fresh clean-status and ancestry check preceded `git merge --ff-only a56767b26686e1e308278161400a16ee717b5806` in this isolated branch only. The exact verified base and current uncommitted HEAD are both `a56767b26686e1e308278161400a16ee717b5806`.

Owned worktree: `C:/Users/waleed_Mohamed/.t3/worktrees/MergePilot/T3-CODE-523457dd-7f8ce47cbba26dec`, branch `T3-CODE/openai-gpt6-reasoning-classification`. Parent root recovery and unrelated worktrees were not changed.

Read before changes: `AGENTS.md`, `docs/architecture.md`, ADR-0011, ADR-0036, and `docs/subscription-auth.md`. ADR-0036's stored budget/default and subscription exemption remain unchanged. ADR-0011 requires preflight to price the requested output including thinking headroom; the correction follows that contract.

## Confirmed causes and bounded implementation

1. The native reasoning regex recognizes o-series/GPT-5, excluding GPT-6. A separate catalog regex also excludes GPT-6. An explicit model capability table now covers exactly the five documented IDs below; the native mapper, new-model catalog efforts, review headroom, and Test Connection read that table. No generic GPT-6 prefix, future version, arbitrary snapshot, or chat suffix gains inferred capabilities.
2. The native adapter formerly dropped all headroom for an explicit effort it did not recognize, including `off`. For these GPT-6 models an omitted wire effort leaves model-default reasoning active. The new shared sizing helper reserves default headroom in that case. A supported wire `none` gets zero thinking headroom. Existing legacy adapter sizing assertions remain intact.
3. Chat usage exposes `prompt_tokens_details.cache_write_tokens`, but the adapter hardcoded writes to zero. The adapter now uses the optional SDK field, subtracting reads and writes from ordinary input. Missing/null details and missing/zero counters keep legacy behavior. Completion tokens already include reasoning; no reasoning tokens are added again.
4. `estimateCostUsd` claimed a worst case but priced every prompt token at the ordinary input rate. Cache writes or configured reads can cost more. It now uses `max(inputPerMTok, cacheReadPerMTok ?? inputPerMTok, cacheWritePerMTok ?? inputPerMTok)` for all estimated input tokens. Actual usage still uses disjoint buckets with their own rates; missing cache rates still fall back to ordinary input. This is a shared estimator correction affecting all providers using these flat prices, including paid fallbacks and estimates used when usage is missing. No rate is invented.
5. Current OpenAI guidance rejects `temperature` when these models reason. The native adapter omits a supplied temperature for the five documented models unless the supported wire effort is `none`. Legacy models retain their existing temperature behavior. Test Connection already supplies no temperature or tools.

The legacy o-series/GPT-5 mapper still accepts only `minimal`, `low`, `medium`, and `high`. Its regex and explicit unsupported/off effort headroom remain unchanged. The older catalog fallback (including its pre-existing broader `codex-`/GPT-5 recognition) and older Test Connection behavior are retained, rather than silently expanding this task into legacy capability migration. New GPT-6 IDs use the shared table and sizing rule consistently.

## Configuration behavior if the patch is later shipped

| API model IDs | Accepted wire efforts | Omitted wire effort |
| --- | --- | --- |
| `gpt-6-astra`, `gpt-6.1-sol` | `low`, `medium`, `high`, `xhigh`, `max` | Model default reasoning |
| `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | Model default reasoning |

The catalog offers `off` in addition to those accepted values. `off` means omit the parameter, not disable reasoning. Unknown efforts and `minimal` are also omitted; unsupported `none` on Astra/6.1 Sol is omitted, not silently mapped to `low`. Effort matching retains existing trimming and case normalization. Official migration advice recommends choosing `low` when migrating unsupported `none`/`minimal`, but this patch does not edit stored choices or apply that migration automatically.

| Configured effort on a listed model | Added output tokens |
| --- | ---: |
| Unset, `off`, unsupported/unknown | 8,192 |
| Supported `none` | 0 |
| `low` | 2,048 |
| `medium` | 8,192 |
| `high` | 16,384 |
| `xhigh` | 24,576 |
| `max` | 32,000 |

These headroom amounts are MergePilot's existing heuristic table, not OpenAI guarantees of how much a model will think. Review preflight (`modelFromAdapter.outputTokensFor`) and the actual Chat request use the same total. Test Connection uses the same addition above its 16-token answer budget. The `thinking: 'off'` retry still does not override the native API mapper, matching existing behavior; sizing follows the request actually sent.

For an already configured GPT-6 API model, previously ignored efforts now reach the provider. Token ceilings and estimates increase; reviews, verification, retries, batches, or paid switches can fail the existing affordability gate sooner. The default cap is not raised. Actual completion usage, including reasoning, is charged at the configured output rate. No actual affected workspace/bot count was collected because no live settings or credentials were queried.

## Illustrative impact only: no installed or live rates asserted

Assume GPT-6.1 Sol ordinary input $2/MTok, cache writes $2.50/MTok, output $10/MTok; two calls with 50,000 input tokens each, review answer 4,096 and verification answer 2,048. These numbers illustrate the documented Standard rates and existing headroom heuristic; they are not a reading of this installation's prices.

| Configured effort | Total requested output, both calls | Ordinary-input estimate | Conservative estimate with configured write premium |
| --- | ---: | ---: | ---: |
| `medium` | 22,528 | $0.42528 | $0.47528 |
| `high` | 38,912 | $0.58912 | $0.63912 |

The original GPT-6 path reserved only the 6,144 answer tokens: $0.26144 with ordinary input. A $0.50 hypothetical cap therefore admits different work after correction. This excludes exploration, extra batches, retries, judge calls, model/method switches, long-context surcharges, regional/service-tier adjustments, and actual cache-hit distributions. It is not a live spend forecast or a proposal to change any cap.

## Pricing and accounting limits

For valid Chat usage, ordinary input equals total prompt tokens minus cache reads minus cache writes, clamped at zero as in the existing subtraction policy. Example regression: prompt 12,000, reads 4,000, writes 7,000 becomes ordinary input 1,000. Completion 200 with a 150-token reasoning detail stays 200 output, not 350.

The correction does not install official prices into the database or change the source precedence. Pricing still comes from existing manual overrides, allowed repository pricing, or the existing public catalogs. Absent prices remain unknown; absent cache rates use the ordinary-input rate. Consequently a missing/stale/incorrect write premium can still understate both real and estimated cost. Before this estimator fix, even a correctly configured premium could be underreserved; after it, estimates bound only the supplied flat rates and input/output token estimates.

`ModelPricing` has one cache-write rate. OpenAI documents different 30-minute and 12-hour write rates and, for Responses, separate write-lifetime counters. This Chat adapter consumes the documented aggregate Chat field. It does not infer a lifetime, add an undocumented field, or combine TTL prices. Mixed lifetimes, long-context multipliers, service tiers, regional adjustments, other charges, estimated prompt inaccuracies, and provider billing rounding remain outside this flat-price model. A mathematically conservative configured-rate estimate is not a complete invoice guarantee.

Subscription calls are a different path: `SubscriptionAdapter` delegates supported model levels to pi-ai, passes `reasoning`, and uses `subscriptionOutputTokens`. Installed pi-ai `1.1.0`'s Codex request builder sends no output limit; the existing Codex regression proves the bare answer budget and absence of `max_output_tokens`. Its bundled Codex JSON already includes GPT-6 models and declares `off: null` for GPT-6.1 Sol, versus `off: "none"` for GPT-6 Sol. This is independent of the native API-key regex defect. No subscription code or catalog changed. Usage remains reported; incremental subscription API cost remains zero. Paid method/model fallback and API-equivalent display rules remain as documented in `subscription-auth.md`. The shared estimator affects paid estimates, not subscription prices.

## Official evidence and installed SDK

Accessed 2026-11-14; no provider/model request was made. Only official OpenAI material supports protocol/model/pricing claims:

- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md): supported efforts, default medium, Chat endpoint, model ID, and illustrated Standard prices.
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra.md): efforts and Chat support.
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol.md), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna.md), [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md): supported `none`, named efforts, and Chat support.
- [Latest-model migration guide](https://developers.openai.com/api/docs/guides/latest-model.md), compatibility/migration section: `reasoning_effort` for Chat versus `reasoning.effort` for Responses; unsupported `none`/`minimal` migration guidance; temperature restrictions; tool calls need Responses on the relevant models. This adapter sends no tools and stays on Chat.
- [Chat create API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), usage section: optional `prompt_tokens_details.cache_write_tokens` (default zero), separate cached reads, and reasoning included in total completion tokens.
- [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching.md), usage/pricing sections: mutually exclusive ordinary/read/write input buckets and lifetime-dependent write pricing; the examples explicitly subtract reads and writes from total input.

Frozen-lockfile install used pnpm `12.11.2`, matching `package.json`, with Node `v24.21.0`. Installed OpenAI SDK `7.32.0` already types the optional write field in `resources/completions.d.ts`, so the patch uses that type directly without `any`, casts, dependency additions, or lockfile changes. pi-ai `1.1.0` Codex implementation was inspected locally at `dist/api/openai-codex-responses.js`.

## Regression proof and validation artifacts

Validation source copy (not a second Git worktree): `E:/Dev/Validation/openai-reasoning-20261114`. Dependency store: `E:/Dev/pnpm-store/v11`; installed dependencies, compiler outputs, Vite outputs, and logs stay under `E:/Dev`. Source changes remain only in the owned Git worktree. No dependencies or build outputs were created there.

Red proof ran all final added tests against the five original production source files from exact base `a56767b26686e1e308278161400a16ee717b5806`, restored only in the disposable validation copy: 30 failed, 121 passed across six test files. Named failing regressions include:

- `recognizes only documented GPT-6 model %s and its effort levels`.
- `keeps GPT-6.1 wire and preflight headroom aligned for effort %s`.
- `sends none only to a GPT-6 model that supports it, reserving no thinking tokens`.
- `offers documented GPT-6 efforts without inferring unknown model capabilities`.
- `uses GPT-6 native effort and headroom for %s / %s`.
- `conserves disjoint cache-write input buckets and counts completion reasoning once`.
- `reserves the largest configured input bucket rate (write %s, read %s)`.
- `only sends temperature when %s / %s supports it`.
- `reserves GPT-6 headroom through the review model and enforces the priced call boundary`.

All pre-existing assertions were preserved. The old uncached worst-case estimator fixture now sets its cache-write rate equal to ordinary input (3.0 instead of 3.75), making its unchanged $0.21144 assertion mathematically valid; the new premium-write and premium-read cases independently assert the corrected higher bounds. No test was skipped or removed.

Commands actually run, from the validation source copy unless stated otherwise:

| Command | Actual result | Log under `E:/Dev/Validation/` |
| --- | --- | --- |
| `pnpm --version`, `node --version` | `12.11.2`, `v24.21.0` | Recorded above |
| `pnpm install --frozen-lockfile --store-dir E:/Dev/pnpm-store` | Exit 0; lockfile unchanged, 482 packages reused | `openai-reasoning-20261114-install.log` |
| `pnpm typecheck` before first tests | Exit 0 | `openai-reasoning-20261114-typecheck-baseline.log` |
| `pnpm exec vitest run packages/engine/src/providers/effort.test.ts packages/engine/src/providers/openai/effort.test.ts packages/engine/src/providers/openai/openai.test.ts packages/engine/src/providers/catalog.test.ts packages/engine/src/providers/connection.test.ts packages/engine/src/budget/cost.test.ts --reporter=verbose` against original production code | Expected exit 1; final regression proof: 30 failed, 121 passed, six files | `openai-reasoning-20261114-red-final.log` |
| `pnpm typecheck` after final source sync | Exit 0 | `openai-reasoning-20261114-typecheck-final.log` |
| `pnpm lint` | Exit 0; no ESLint findings | `openai-reasoning-20261114-lint-final.log` |
| `pnpm exec vitest run packages/engine/src/providers packages/engine/src/budget packages/engine/src/pricing packages/engine/src/review --reporter=verbose` | Exit 0; 1,236 tests in 91 files | `openai-reasoning-20261114-green-final.log` |
| `pnpm build` | Exit 0, all workspace packages | `openai-reasoning-20261114-build-final.log` |
| `git diff --check` in owned Git worktree | Exit 0 | Included in final receipt |

Preliminary red/green/typecheck/lint runs also completed; their logs retain the same prefix without `-final`. Earlier red proof had 27 then 29 failing cases as regression coverage was completed, and the preliminary broader green had 1,235 passing tests before the additional review-model boundary case. Final results above are authoritative. The PowerShell host formats pnpm's stderr command echoes (`$ eslint .`, `$ pnpm -r typecheck ...`) as `NativeCommandError` records even on exit 0. These are present in logs; no TypeScript or ESLint diagnostic failed the gates.

Build warning: `(!) Some chunks are larger than 500 kB after minification.` The main web chunk was 806.15 kB (229.54 kB gzip). No chunk settings or application code were changed to suppress it.

Validation intentionally excludes live provider access, production/settings checks, full `pnpm check`/all-project test suite, `pnpm test:integration`, Action `pnpm bundle`, database integration/native database operations, benchmarks, and dispatch. Mocked provider tests include failure classification, cancellation, redaction, subscription transport, schema, and truncation checks without real model calls. Passing mocks do not establish live model availability, latency, quality, actual cache behavior, or invoice accuracy. No validation failure remains within the gates run.

Final review artifacts (absolute paths):

- `C:/Users/waleed_Mohamed/.t3/worktrees/MergePilot/T3-CODE-523457dd-7f8ce47cbba26dec/docs/plans/openai-reasoning-impact.md`: this report.
- `E:/Dev/Validation/openai-reasoning-20261114.patch`: full tracked diff plus the new report, against the exact base.
- `E:/Dev/Validation/openai-reasoning-20261114-source-manifest.json`: base/head/branch, changed file SHA-256 values and validation-copy equality.
- `E:/Dev/Validation/openai-reasoning-20261114-validation.json`: command outcomes, test counts and artifact paths.
- Final gate logs: the absolute directory above plus each filename in the table.

## Reviewable source files

- `packages/engine/src/providers/effort.ts` and `effort.test.ts`: bounded model capabilities, mapper, headroom, and legacy/unknown-model regression coverage.
- `packages/engine/src/providers/openai/adapter.ts`, `effort.test.ts`, `openai.test.ts`: request/headroom, temperature, cache usage, budget boundary, and legacy coverage.
- `packages/engine/src/providers/catalog.ts` and `catalog.test.ts`: new-model effort list consistency.
- `packages/engine/src/providers/connection.ts` and `connection.test.ts`: mocked Test Connection protocol and sizing.
- `packages/engine/src/budget/cost.ts` and `cost.test.ts`: configured-rate conservative estimate with fallback/conservation tests.
- `docs/usage.ar.md`: owner-facing usage impact in the document's existing Arabic language.
- This report: evidence, impact, boundaries, validation and limitations.

Next action: parent reviews the uncommitted patch and its impact; publication or any operational/settings change requires the parent's separate decision.

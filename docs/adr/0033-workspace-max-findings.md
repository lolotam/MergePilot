# ADR-0033: Findings limit per review as a workspace setting, 1–50

**Date:** 2026-10-17 · **Status:** accepted (owner, س46) · **Amends:** ADR-0017 (consensus publishing), ADR-0011 (output budgets)

## Context

A review published at most `review.maxFindings` findings: 5 by default, 1–20 allowed, and only a repository's `.mergepilot.yml` could change it. The owner asked for a dashboard setting, a dropdown from 5 to 50 in steps of 5, so a workspace can choose how many comments one review writes on a pull request.

The number was used in four places:

1. the system prompt of every review call: "Return at most N findings";
2. every batch call of a large PR (ADR-0013, ADR-0031), with the same N;
3. `selectFindings`, the final cap of one bot's review;
4. the audit, which caps its merged result at `min(N × chunks, 50)`.

A consensus panel (ADR-0017) merged the reviews of up to five bots without capping the result, so its one review could publish up to N per bot. Every review call asked for 4096 answer tokens and every verification call for 2048. At 50 findings that is too little, and the JSON answer would be cut.

## Decision

1. **Setting.** `workspace_settings.max_findings` (migration 0013): a smallint, default 5, with a CHECK allowing 5–50 in steps of 5. The settings contract accepts exactly `MAX_FINDINGS_CHOICES` (5, 10, …, 50). Only an admin or owner can change it, through `PUT /settings`; members can read it. A `PUT` that leaves the field out keeps the stored value. Stores read back 5 when it was never set. Settings backup and restore carry it like every other settings field. The dashboard shows it as a dropdown next to the minimum severity.
2. **Schema.** The repository schema allows `review.maxFindings` from 1 to 50 (`MAX_FINDINGS_LIMIT`). The default stays 5. A repository can still ask for fewer than 5, or for a number that is not a multiple of 5.
3. **Precedence (GitHub App).** The workspace setting is the default. A repository file that names `review.maxFindings` overrides it. Repository config is untrusted only for credentials and URLs (ADR-0008 amendment), not for how many comments a review writes. This works through `parseConfig`'s `defaults.maxFindings`: the worker passes the workspace value to `loadRepoConfig`, and `parseConfig` fills `review.maxFindings` only when the file's `review` mapping leaves it out. Without a file, `effectiveConfigFor` uses the workspace value directly. `parseConfig` lists `maxFindings` in `defaulted` when it filled it, and `effectiveConfigFor` adds an inherited limit to the review marker's `configHash`. So changing the dashboard limit makes the next review of a PR a full one (`selectIncrementalFiles`), and a file that names its own value keeps its hash. The default 5 is left out of the hash, so hashes from before this setting stay the same and nothing is re-reviewed at deploy. Repository `budget.pricing` still needs the file itself to name the provider and model: only `provider` and `model` in `defaulted` turn it off. Every bot of a panel gets the same limit, because they share one repository config and one workspace. The GitHub Action has no workspace, so it keeps the file value or the default 5.
4. **What the limit counts.** It counts the findings of one published review: inline comments and findings outside the diff together. (`selectFindings` caps the list before anchoring splits it.)
   - **One bot, or a panel in separate mode:** each bot publishes its own review, so the cap applies per bot. Three bots at 20 can publish up to 60 comments on a PR, in three reviews.
   - **Batched review:** each batch call is asked for at most N, and the bot's review keeps N in total, most severe first (`selectFindings` after the batches merge). A batch that finds fewer leaves room for the others.
   - **Consensus mode:** the panel publishes one review, so the cap applies to that merged review. `mergePanelFindings` gets `maxFindings` and keeps that many agreed clusters: most severe first, then those the most bots found, then by path and line. The clusters over the limit are returned as `overLimit`, and the panel summary lists them under «Over the findings limit (n)», next to «Below agreement». Nothing is dropped silently. Critical and high findings bypass the agreement threshold, but not this limit: when there are more than N of them, high ones are left out before critical ones, and within one severity the least agreed are left out first.
5. **Output budget.** `review/output-budget.ts`:
   - Review call: `max(4096, 1024 + 300 × N)` answer tokens, which is 4096 up to 10 findings and 16,024 at 50.
   - Truncation retry: twice the first budget, at most 32,768 (it was at most 16,384).
   - Verification call: `max(2048, 128 × findings checked)`, at most 16,384. Its retry is twice that, at most 16,384.

   Adapters still add their thinking headroom on top. **Model output limit:** an API-key call never asks for more than the model's known output limit. The limit is the `maxTokens` of pi-ai's bundled model catalogs, the same field `subscriptionOutputTokens` caps subscription calls at (`providers/output-limits.ts`). Only providers whose MergePilot id names the same API as a pi-ai catalog are looked up: anthropic, openai, gemini (pi-ai's google), xai, deepseek, nvidia, openrouter, vercel-gateway, opencode-zen, opencode-go, zai and xiaomi. `modelFromAdapter` clamps the answer budget of every call so that answer plus thinking headroom fits the limit, keeping the headroom whole, and the budget preflight prices the clamped request. When the configured model's clamp leaves less answer room than N findings are sized for, the completed result carries `outputLimit`, and the summary (the panel's, per bot) says so: the answer may hold fewer findings. This is a disclosure, not an incomplete review. An unknown provider or model (`custom`, `zai-coding`, a model the catalog does not list) keeps the requested budget. When the thinking headroom alone reaches the limit, the answer is left as asked, because cutting it cannot help.

   At the default 5, a single-call review requests exactly what it did before. A batched review's verification budget now grows with the findings its batches returned (25 findings from five batches ask for 3,200 tokens), where the fixed 2048 could cut the answer. The budget preflight prices these larger limits. For verification it assumes the worst case: every call returned N findings.
6. **Safety caps that stay.** The run record keeps at most 200 findings (`prepare-run-result.ts`). The audit keeps its `min(N × chunks, 50)`. The judge's same-issue pairs stay capped at 50 per request (`MAX_CONSENSUS_PAIRS`, `MAX_SEMANTIC_PAIRS`). Pairs past that cap are compared by title only. The GitHub publish path has no cap of its own.

## Consequences

- Existing workspaces and repositories review exactly as before: the column default is 5, and a file that names a value keeps it. The usage guide's example files name `maxFindings: 5`, so a repository copied from them overrides the dashboard. The dashboard hint and the usage guide say so.
- A higher limit means longer answers. At N = 50 the preflight output estimate is about four times the default, so on an expensive model and a large PR more reviews can stop at `budget.perReviewUsd` (default $0.50). Owners who raise the limit may need to raise that budget too.
- **Model output limits.** A model with a known small output limit no longer fails at a high N: an 8,192-token model at N = 50 gets about 8,192 tokens minus its thinking headroom for the answer, and the summary says it may hold fewer findings. A model whose limit is unknown still gets the full budget. If that model's real limit is smaller, the provider rejects the call, as before this ADR. Choose a lower limit for such models.
- More findings also mean a longer verification prompt and more judge questions. Their cost is counted and capped like before.

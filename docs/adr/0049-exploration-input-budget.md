# ADR-0049: Reserve input space for repository exploration

**Date:** 2026-10-30 · **Status:** proposed (implementation for B23; pending review) · **Amends:** ADR-0046 · **Related:** ADR-0013, ADR-0045

## Context

The B23 evaluation counted exploration skipped or cut in 30 of 265 reviews (11%) across 24 PRs. Three separate paths lose evidence: the first exploration call adds protocol instructions to an already full review prompt; a successful read produces a block that is accepted or discarded as a whole; and the GitHub note displays only counts despite the engine already disclosing paths. Batched reviews explicitly bypass exploration, including large patches split under ADR-0045.

## Options

- **A. Reserve input headroom, explore each planned batch with shared read state, fit results, and name read paths.** The implementation.
- **B. Raise model/input limits.** This moves the boundary without preserving any room for the protocol or results and can increase cost.
- **C. Truncate the diff to make space.** Rejected: keep ADR-0045's parts, true line numbers, part limit and incomplete disclosures.
- **D. Explore the whole oversized PR once or grant a fresh read budget per batch.** Rejected: the whole prompt still exceeds the limit; a fresh read budget multiplies repository reads with batch count.

## Decision

1. **Input reserve only when a reader is supplied.** From the smaller of `review.maxPromptTokens` and `budget.maxInputTokens`, reserve 20% for rendered exploration results, capped at `review.explore.maxReadTokens`, plus the estimated protocol instructions and 32 tokens of headroom. This is internal policy, with no new configuration. Context fits in what remains; a diff too large for that base prompt is split into batches rather than cut. Batch sizing also allows for fixed prompt text, the manifest and rendered patch line numbers. Each actual exploration and answer prompt is still checked against its applicable input cap. Irreducibly oversized instructions, time and monetary limits can still stop exploration.
2. **Per-batch exploration.** Each planned batch may run up to `maxRounds` rounds before its answer. All batches and verification share one `ExploreBudget`, read cache and spend tracker: `maxReadTokens` remains per review. Previously gathered evidence can be reused after that read budget is exhausted. Exploration reserves the remaining batch answers and verification, including output allowances; actual usage and spend include every exploration call. No provider/model fallback is introduced.
3. **Fit results instead of discarding all of them.** Keep complete entries in request order while they fit; shorten an overflowing entry with an explicit truncation marker, retaining intact untrusted fences. Prefer line boundaries, with a marked character prefix for a single oversized line. Later small entries can still fit. Measure the rendered, redacted block. Apply fitting to subsequent exploration rounds as well as the answer; disclose when the answer's results were trimmed. Monetary affordability is rechecked after exploration and still may require leaving evidence out. The verifier receives the retained evidence, subject to its existing input and spend limits.
4. **Traceability.** Both language variants of the note list the first ten distinct read paths (each capped at 200 characters and neutralized), then the number remaining. They are paths read, not a claim that every line was retained in the answer; a trim disclosure accompanies partial evidence. No content or model response is added to the note.

## Consequences

- Large PRs may use more batches and exploration calls; `maxFileParts`, the review deadline, total planned input and monetary caps continue to bound work. Total review rounds can now be `batch count × maxRounds`; verifier rounds remain separate.
- The 20% share balances space for evidence with diff/context coverage; it is a policy choice to measure, not a claim of an optimal ratio.
- Deterministic fake-model tests cover full patches, split parts, overflowing results, shared reads/usage, input caps and path disclosure. The under-3% target requires a production traffic comparison after approval and release; this implementation does not deploy or change the running timeout experiment.
- B22, A2 and B3/B7 remain outside this decision. Nothing executes repository code and no shell-specific dependency enters the engine.

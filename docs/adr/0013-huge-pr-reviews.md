# ADR-0013: Huge PRs Never Fail as a Whole — Size Guard, Capped Batches, Empty-Reply Retry, Timeouts

- **Status:** Accepted (2026-10-12)
- **Related to:** ADR-0001, ADR-0003, ADR-0008, ADR-0011, CLAUDE.md

## Context

A live review on the hosted App (provider `zai-coding`, model `glm-5.3`, effort `on`) of a PR with
85 files and +22k lines ran for 28 minutes and then failed with
`batch 1: empty-response: model returned no text` / `batch 2: empty-response …`. Nothing was published.

Root causes:

1. **One whole-PR call first, whatever the size.** The pipeline always sent the entire diff in one
   call and only split the PR after a *truncated* answer (ADR-0011). A huge diff spends a long
   time in that first call before anything else can happen.
2. **Recovery batches were halves.** `batchFilesBySize` without a cap splits the PR in two, so each
   batch of a 22k-line PR is still enormous.
3. **Empty, reasoning-only replies were final.** GLM with thinking on can spend every output token
   on reasoning and return no visible text. `empty-response` was not retried at all.
4. **No time limits.** A slow call blocked the review for as long as the provider kept the
   connection open; the review had no overall limit either.
5. **All-or-nothing batches.** Each batch failing the same way left nothing to publish.

## Decision

1. **Size guard up front.** Before the first model call the pipeline estimates the whole-PR
   prompt. Above `review.maxPromptTokens` (default 60,000) it skips the whole-PR call and reviews
   the PR in batches straight away. Below it, behaviour is unchanged: one call, then ADR-0011
   truncation recovery, which keeps its "at least two batches" split (`batchFilesBySize`).
2. **Real batch cap.** Up-front batches are filled in file order up to `review.batchTokens`
   (default 24,000 estimated diff tokens per batch, `batchFilesByTokenCap`). A single file bigger
   than the cap is its own batch, its patch cut at a line break to the cap and ended with
   `[patch truncated: the rest of this file was not sent for review]`; the review discloses
   `<path>: patch truncated to fit review.batchTokens`.
3. **Empty-reply retry with thinking off.** When a call returns `empty-response`, it is retried
   ONCE with `thinking: 'off'` on `ReviewModelRequest` (carried to adapters as
   `GenerateOptions.thinking`). The OpenAI-compatible adapter maps it to GLM
   `thinking: { type: 'disabled' }` (and drops the thinking headroom from `max_tokens`), and for
   OpenAI-style `reasoning_effort` servers to the lowest value every such server accepts (`low`),
   only when the call would otherwise think. Other backends (Anthropic, OpenAI native, Gemini,
   Claude Code CLI) ignore it. A truncation retry after a thinking-off answer keeps thinking off.
   The retry is budget-gated like every other extra call (ADR-0011), charged at the configured
   call's requested output tokens (a safe ceiling). It applies to the whole-PR call, every batch
   and the verification pass. It is disclosed only when it does not help:
   `empty-response retry skipped: budget limit reached`, `empty-response retry failed: <code>`, or
   the parse error suffixed `(also with thinking off)`.
4. **Per-call timeout.** Every model call gets its own timeout `review.callTimeoutMs` (default
   300,000 ms), combined with the caller's signal through `AbortSignal.any`. The wrapper also
   stops waiting when the timer fires, for a backend that ignores the signal. A timeout is an
   `LlmFailure` with code `TIMEOUT`. The timeout wraps each model of the fallback chain
   separately, so the existing ADR-0008 chain decides what happens next (`TIMEOUT` is kind
   `network`, a fallback trigger) and any switch is disclosed. There is no silent fallback.
5. **Overall time limit.** `review.totalTimeoutMs` (default 1,200,000 ms) is measured from the
   start of `runReview`. Once reached, no new batch starts and the verification pass is skipped
   (`verification skipped: time limit reached`); the review finishes with what is done and
   discloses `time limit reached: N of M batches reviewed` (N = batches started). Calls already
   in flight are not aborted; each is still bounded by its own timeout.
6. **Partial success.** When at least one batch answered, the review is `completed` with
   `complete: false`, and every failed or skipped batch is listed with its file paths (at most
   10 per batch, long paths shortened from the left, `+N more`):
   `batch 2 (src/a.ts, src/b.ts): TIMEOUT`, `batch 3 (src/c.ts): budget limit reached`,
   `batch 4 (src/d.ts): skipped: time limit reached`. Only when NO batch answered is the review
   `failed` (`no batch produced an answer (M batches)`, every batch reason in `detail`).
7. **Budget preflight in batched mode** prices every batch prompt (plus the verification worst
   case) instead of one whole-PR call. `budget.maxInputTokens` still applies to the whole-PR
   prompt estimate, as before. Usage and spend are summed across every call, retries included.

## Consequences

- A huge PR is reviewed in bounded pieces from the start, so a 22k-line PR gives a partial,
  disclosed review instead of a total failure.
- GLM (and other thinking models) get one cheap second chance when they answer with reasoning only.
- No review can hang: every call is bounded, and the review as a whole stops starting work after
  the time limit.
- Four new optional config keys under `review` (`maxPromptTokens`, `batchTokens`, `callTimeoutMs`,
  `totalTimeoutMs`) with the defaults above; existing configs keep working unchanged.
- `executeBatchedReview` moved to `review/batch-run.ts` and `recoverReviewTruncation` to
  `review/truncation.ts`; both stay exported from the engine package.

## Amendment (2026-10-13): DeepSeek thinking

DeepSeek's API thinks by default (effort `high`) and is switched with `thinking: {type:
enabled|disabled}` plus `reasoning_effort: low|high|max`. The preset now uses the `deepseek` thinking
style:
- The empty-reply retry sends `thinking: {type: disabled}`.
- V4 and the canonical ids (`deepseek-flash`, `deepseek-pro`) reserve the `high` budget when no
  effort is set.
- Headroom follows the effort DeepSeek really runs (`medium` maps to `high`).

The empty batches on #84 came from the heavy model `deepseek-v4-pro`, whose default reasoning used
up the generic 8192-token headroom.

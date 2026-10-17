# ADR-0011: Large PR Output Robustness — Thinking Headroom, Structured Output, and Truncation Recovery

- **Status:** Accepted (2026-10-12)
- **Related to:** ADR-0001, ADR-0003, ADR-0008, CLAUDE.md

## Context

When reviewing large pull requests with reasoning models (e.g. Gemini 2.5/3.x, OpenAI o1/o3/gpt-5, DeepSeek reasoner, GLM thinking, OpenRouter reasoning models), review runs frequently failed with `"No JSON object found in model response."`.

Investigation revealed the root causes:
1. **Thinking token consumption of maxOutputTokens**: Even with dynamic thinking (effort unset), reasoning models count internal thinking tokens against `maxOutputTokens`. With a 4096 output cap, large PR diffs trigger extensive chain-of-thought reasoning that exhausts the token allowance before JSON output is completed, resulting in an unclosed/truncated JSON object with `finishReason: "max-tokens"` (or `"length"`).
2. **Brittle JSON extraction**: The initial parser relied on a naive regex / single `{...}` slice that failed on truncated output, leading/trailing conversational text, or multiple JSON objects.
3. **Budget preflight discrepancies**: Without calculating thinking headroom into preflight cost estimation, preflight pricing did not align with actual tokens requested.
4. **No recovery for massive diffs**: A PR diff too large for a single model response context/output budget would permanently fail instead of being partitioned.

## Decision

1. **Default Thinking Headroom (8192 tokens)**:
   - For all known thinking/reasoning models across providers (Gemini 2.5+/3.x, OpenAI o-series/gpt-5, DeepSeek reasoner, GLM thinking, OpenRouter reasoning models) when no explicit `effort` is configured, `requestedOutputTokens` automatically adds an 8,192 token thinking headroom allowance to the base answer tokens (4,096 tokens, totaling 12,288 tokens).
   - This ensures the visible JSON answer preserves its full 4,096 token space.
   - The preflight budget calculation (`outputTokensFor`) accounts for this headroom consistently so preflight estimation matches actual usage.

2. **Structured Output Where Supported**:
   - For Gemini: sends `responseMimeType: "application/json"` and `responseSchema` (using zod-to-json-schema) in all review and audit calls.
   - For OpenAI & OpenAI-compatible providers: sends `response_format: { type: "json_object" }` for presets known to support it (`openrouter`, `deepseek`, `xai`, `zai`, `zai-coding`) whenever `responseSchema` is provided, retaining explicit schema instructions in the prompt.
   - If an OpenAI-compatible server returns HTTP 400 rejecting `response_format`, the adapter silently retries once without `response_format`.

3. **Tolerant Extraction & Informative Error Codes**:
   - Extraction checks markdown code fences (```json ... ```) first, followed by a character-by-character scanner for balanced `{...}` spans. String state is tracked only inside an object and reset whenever an object closes, so quotes in surrounding prose cannot flip it and one object cannot leak into the next. A stray `{` in prose that never closes does not swallow later objects: the scan resumes just past it (bounded).
   - Iterates through candidates and selects the first object satisfying schema validation.
   - Distinct error codes:
     - `truncated`: decided by the finish reason FIRST. `max-tokens` / `length` mean truncated. Only a stream that ended without a finish reason (absent, or `error`, which `collectText` reports when no finish chunk arrived) falls back to the structural check (an object that opened and never closed).
     - `invalid-json`: the model finished (`stop`, `end_turn`, any other explicit reason) but the answer does not parse or match the schema, even if it contains an unclosed `{`. No retry and no batching: a bigger output budget would not fix it.
     - `empty-response`: whitespace or empty model response text.
   - Applied symmetrically to `parseReviewAnswer`, `parseVerifyAnswer`, and audit parsing (`isTruncatedAnswer`).

4. **Two-Stage Truncation Recovery**:
   - **Step 1: 2x Output Retry**: If a call ends `truncated` (or with finish reason `max-tokens`), retry once with double the answer tokens (`Math.min(maxOutputTokens * 2, 16384)`), only if the budget gate below allows it.
   - **Step 2: Batch Splitting Fallback**: If the retry is skipped, fails, or is still truncated and the PR has multiple reviewable files, partition files into size-bounded batches (`batchFilesBySize`), review each batch within the budget gate (each batch may itself get one gated truncation retry), merge findings deduplicated by `path + line + title`, and combine usage/cost across all attempts.
   - Applied to the review pipeline, the verification pass (one gated retry at 4096 answer tokens), and the audit pass (one gated retry per chunk at 8192 answer tokens).

5. **One Budget Gate for Every Extra Call**:
   - Every extra call (review truncation retry, each batch and its retry, the verification call and its retry, each audit chunk retry) runs only when `spent so far + estimated cost of the call <= budget.perReviewUsd`. The estimate is priced on the output tokens the call REALLY requests, `outputTokensFor(answerTokens)`, i.e. answer budget plus the model's thinking headroom, since thinking is billed as output.
   - Spend is tracked per review by `SpendTracker`: a call that reports usage is charged its real cost; a call that reports no usage, or all-zero usage (some OpenAI-compatible streams such as Z.ai, OpenCode or custom endpoints), is charged its ESTIMATED cost (prompt estimate + requested output tokens). A call that throws is charged its estimate too, since it may have been billed. Spend accumulates across the retry and all batches, so the total never exceeds `perReviewUsd`. The reported review cost is this same tracked spend.
   - The audit has no audit-wide budget, so each audit chunk is treated as one review-sized unit: the chunk's first call and its retry together stay within `perReviewUsd`.
   - Nothing is skipped silently: a skipped step is disclosed as an incomplete reason (`truncation retry skipped: budget limit reached`, `batch N: budget limit reached`, `verification retry skipped: budget limit reached`), and a failed retry is recorded with its `LlmFailure` code or a secret-redacted message (`truncation retry failed: <code>`, `verification retry failed: <code>`, appended to the audit chunk error). When recovery still ends without an answer, the failed result carries these reasons in `detail`.

## Consequences

- Prevents review failures on large diffs and complex reasoning model invocations.
- Protects user budget: every retry and batched sub-call passes the same gate, priced with thinking headroom, and spend accumulates across calls even on providers that report no usage.
- A finished-but-invalid answer fails fast as `invalid-json` instead of paying for retries and batches.
- Gracefully degrades to chunked review when diff output exceeds single-response token boundaries.

## Amendment — JSON-mode fallback scope

The compatible adapter retries once without `response_format` only when the HTTP 400 body says the
server rejected JSON mode or an unknown/unsupported request field (`response_format`, `json_object`,
"unsupported parameter", "unknown field", "unrecognized", "not supported", "extra inputs",
"additional properties"). Any other 400 (context too long, invalid model) is a real error: it is not
retried and keeps its original message. The first response body is read before the retry so its
connection is released.

## Amendment (2026-10-13): invalid JSON escapes

Models that quote code in `evidence` or `body` (regexes, Windows paths) sometimes write escapes JSON
does not allow, such as `\d` or `C:\Dev`. One of them used to fail the whole answer as
`invalid-json`. The answer and verify parsers now retry once through `review/json-lenient.ts`: a
backslash that does not start a valid JSON escape is taken literally (doubled), then the text is
parsed again. The repair runs only after `JSON.parse` has failed. Valid escapes, including `\`,
are consumed pair by pair and left unchanged, so text that already parses is never altered.

## Amendment (2026-10-13): an answer without a findings list

Seen live on lolotam/MergePilot#97: `nvidia/nemotron-3-ultra-550b-a55b:free` answered with a `summary` and no `findings` key, and the whole review failed as `invalid-json`.

**Parsing now accepts that answer.** A balanced object that has a `summary` and no `findings` key is kept, with no findings, under two conditions:
- no candidate object in the reply has a findings list, so a later full answer still wins over an earlier summary-only draft;
- the answer is disclosed. The review is marked incomplete with the reason "the model answered without a findings list", because the summary may describe problems that were never listed. It is never published as a clean review.

A `findings` value that is present but is not a list is still `invalid-json`.

## Amendment (2026-10-16): adaptive Claude headroom and subscription output limits

Seen live on lolotam/MergePilot#143 and #144: the panel bot running `anthropic:claude-opus-5-5` on
the Claude subscription at effort `high` ended its batches `truncated (finishReason: max-tokens,
outputTokens: 8192)` or with an answer that had no findings list, so the reviews were incomplete.

**Cause.** `SubscriptionAdapter` did not override `requestedOutputTokens`, so a call requested the
bare 4,096-token answer budget, and that is the `max_tokens` pi-ai sent. pi-ai adds a thinking
budget only for budget-thinking Claude models. For adaptive-thinking models (`forceAdaptiveThinking`)
it sends the caller's `maxTokens` unchanged, and managed-effort models such as Claude 5.5
(`supportsMidConvoEffort`) always think adaptively at effort `high` when given no level. Thinking
and the answer shared 4,096 tokens. The 8,192 in the error was the truncation retry (2x answer
budget), which also had no headroom. A second defect: the adapter passed the effort to pi-ai as
`thinking`, a key pi-ai ignores (it reads `reasoning`). A configured effort never reached any
subscription provider: Claude 5.5 always ran at `high`, and older adaptive models ran with thinking
disabled.

**Decision.**
- Adaptive Claude models (`claude-{opus,sonnet,haiku,fable,mythos}` 4.6 and later) get their own
  headroom table, `ADAPTIVE_THINKING_HEADROOM` in `providers/effort.ts`: low 4,096, medium 16,384,
  and high, xhigh and max 32,768. At effort `high` a call now requests 4,096 + 32,768 = 36,864
  tokens, and the truncation retry requests 8,192 + 32,768. Every Claude 5.x model allows 128k output. The
  budget table `THINKING_BUDGET_TOKENS` is unchanged, so `budget_tokens` for older Claude models,
  Gemini budgets and OpenAI headroom stay as they were.
- `AnthropicAdapter.requestedOutputTokens` uses `anthropicThinkingHeadroom(model, effort)`: the
  adaptive table for adaptive models, the budget table otherwise. Claude 5 and later think
  adaptively even when the request sends no `thinking` (no effort, or `off`), so such a call
  reserves the `high` headroom too. That is the default effort on most of them; on Opus 5.5 and
  Haiku 5.5 the default is `medium`, so it over-reserves there. Claude 4.6 to 4.8 run without
  thinking in that case and keep the bare answer budget.
- `SubscriptionAdapter` overrides `requestedOutputTokens` (`subscription/output-tokens.ts`) and
  passes the result to pi-ai. For an adaptive Claude model it adds the adaptive headroom, and a
  managed-effort model with no effort is sized at `high`. For a budget-thinking Claude model pi-ai adds
  the budget itself, so the adapter sends the answer budget and prices answer + budget.
- Grok on the subscription goes through pi-ai's `openai-responses` API, which sends `maxTokens` as
  `max_output_tokens`, and reasoning counts against that limit. The adapter adds the OpenAI-style
  headroom (`thinkingHeadroom(level)`). A Grok model that cannot switch reasoning off and gets no
  level reserves the default 8,192. A model that can switch it off gets effort `none` and no
  headroom. Codex (`openai-codex-responses`) sends no output limit at all, so its calls keep the
  bare answer budget.
- All of these limits are capped at the model's `maxTokens`.
- The effort is passed to pi-ai as `reasoning`. `off`, or a thinking-off retry on a model that can
  switch thinking off, sends no level. `requestedOutputTokens` resolves the level the same way,
  including the per-call `thinking: 'off'` (now part of `OutputTokenRequest`), so a call is sized
  as it is sent.
- No new retry was added. The existing truncation retry inherits the new headroom.

**Cost.** Subscription calls stay at $0 incremental cost: the pipeline prices them at zero whatever
they request. API calls are priced on the limit they actually request. An adaptive Claude model at `high`
is now preflighted at 36,864 output tokens instead of 20,480, so a tight `budget.perReviewUsd` can
skip a review that passed before. An answer cut at `max_tokens` is still reported as
`finishReason: max-tokens` and disclosed as `truncated`; nothing is dropped silently.

## Amendment (2026-10-17): the subscription path sends the response schema

Seen live on lolotam/MergePilot#150 (reviews after cf2351a and 1d94378) and #152 (review
5555184233 after bbad1c0): the panel bot running `anthropic:claude-opus-5-5` on the Claude
subscription was disclosed with "the model answered without a findings list" on every review where
it found nothing. Its summaries said so ("I found no defects"), the runs completed, and no review
with a finding carried the warning. The same symptom was already recorded on #143 and #144
above, before the adaptive headroom shipped, so the headroom and the `reasoning` effort are not the
cause.

**Cause.** The parser flags an answer only when an object has a `summary` and no `findings` key at
all; `"findings": []` parses as a clean review. Every review call carries `responseSchema`, the JSON
schema of the answer in which `findings` is required. The Anthropic, OpenAI-compatible and Claude
Code adapters append it to the system prompt, and the OpenAI and Gemini adapters send it natively.
`SubscriptionAdapter` dropped it, so a subscription model saw only the prose contract of the review
prompt, and Claude left the key out when the list would have been empty.

**Decision.** `SubscriptionAdapter` appends the same schema line as the API adapters
(`llm/schema-instruction.ts`) to the leading system message, or sends it as the system message when
the call has none. pi-ai places that message after the Claude Code identity block it requires for
OAuth, and passes it as instructions to Codex and Grok. The output limit is unchanged. The parser and
its disclosure are unchanged: an answer that still has no findings list is disclosed as before.
The Google Antigravity adapter (ADR-0032) has its own protocol and does not send the schema yet.

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

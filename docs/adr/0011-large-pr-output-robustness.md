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
   - Extraction checks markdown code fences (```json ... ```) first, followed by a character-by-character scanner for balanced `{...}` spans that properly accounts for JSON strings and escaped characters.
   - Iterates through candidates and selects the first object satisfying schema validation.
   - Replaced generic error messages with distinct error codes:
     - `truncated`: identifies unclosed objects or model finishReason `max-tokens` / `length`, reporting finishReason and output tokens.
     - `invalid-json`: valid or closed structure that fails JSON parse or schema.
     - `empty-response`: whitespace or empty model response text.
   - Applied symmetrically to `parseReviewAnswer`, `parseVerifyAnswer`, and audit parsing.

4. **Two-Stage Truncation Recovery**:
   - **Step 1: 2x Output Retry**: If a call ends with `truncated` or `max-tokens` finishReason, retry once with double the output tokens (`Math.min(maxOutputTokens * 2, 16384)`), provided the per-review USD budget permits.
   - **Step 2: Batch Splitting Fallback**: If the retry fails or remains truncated and the PR has multiple reviewable files, partition files into size-bounded batches (`batchFilesBySize`), execute batch reviews within budget, merge findings deduplicated by `path + line + title`, and combine usage/cost across all attempts.
   - Applied to the review pipeline, verification pass (2x retry), and audit pass (2x retry to 8192 tokens).

## Consequences

- Prevents review failures on large diffs and complex reasoning model invocations.
- Protects user budget by ensuring all retries and batched sub-calls verify remaining budget headroom and accumulate total token usage for accurate billing/disclosure.
- Gracefully degrades to chunked review when diff output exceeds single-response token boundaries.

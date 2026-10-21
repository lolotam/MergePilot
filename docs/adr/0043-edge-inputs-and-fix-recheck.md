# ADR-0043: Edge inputs and fix re-check in the review prompt

**Date:** 2026-10-21 · **Status:** accepted (owner's request relayed 2026-10-21) · **Amends:** ADR-0028 (review prompt v3), ADR-0030 (follow-up reviews) · **Related:** ADR-0039 (pattern sweep and rules check)

## Context

A 48-hour comparison of 64 pull requests (2026-10-19 to 2026-10-21) repeated the ADR-0028 measurement: the panel matched 27% of the comparable Codex findings, 26% of the P1 ones. Of the 191 misses, 53% were plain misses — the code was in the shown diff and no bot raised the defect.

Two clusters inside those plain misses stood out:

- **Edge inputs of changed parsing and validation code.** Whitespace-only text, malformed JSON, dates without a time, rolled-over calendar dates: POSTORA#280 (C21, C23, C25, C36, C39, C46, C48 and R3), marketero#3 (C5), MergePilot#163 (R1). The prompt asks for correctness, null/undefined and empty cases, but never names the input classes that keep being mishandled.
- **Fix-of-a-fix commits on follow-up reviews.** A new guard or fix allowed something new, broke something that worked, or sent a request down a partial-failure or retry path: Emlaa#29 (C3), MergePilot#164 (C4 and C6), MergePilot#167 (C3), PayPos#397 (C4). A follow-up prompt says to report what the new changes cause, but never asks what the fix itself changed.

ADR-0039 adds a pattern sweep and a rules check in the same place of the prompt. This ADR does not repeat them.

## Options

- **A. One short always-on section plus one paragraph on follow-up reviews.** An `EDGE INPUTS` section in the system prompt of every call, and a `FIX RE-CHECK` paragraph in the follow-up wording only. Small, cheap, and it lands exactly on the two clusters above.
- **B. A separate model call that enumerates edge inputs.** It could dig deeper per changed parser, but it costs a second call on every review and needs its own prompt, its own output contract and its own merge into the findings. Kept for later if A is not enough.
- **C. Put the fix re-check on every review.** A first review has no earlier fix to re-check, so the paragraph would only add words to the calls that need it least.

## Decision

Option A.

- **`EDGE_INPUTS`** (`packages/engine/src/review/prompt.ts`), after the checklist and after ADR-0039's pattern sweep and rules check: for each changed parser, validator, regular expression, date or number handling, or request-body read, list the edge inputs before concluding (empty or whitespace-only text, malformed JSON, a missing field, a duplicate or case-variant key, an out-of-range number, a date without a time or rolled past a month or year end), and report only those the shown code mishandles. It is part of the system prompt, so it rides every call: the whole-PR call, every batch and the JSON-only retry.
- **`FIX RE-CHECK`** (`packages/engine/src/review/follow-up.ts`), as the third paragraph of `followUpWhatYouSee`: for each guard, condition or error path the new changes add or alter, ask what it newly allows, what it newly rejects or breaks, and which partial-failure or retry path runs when it fires. A fix that moves a defect is still a defect. Only a follow-up review's prompt carries it: a whole-PR review's prompt gets the edge-inputs section and no fix re-check.

## Consequences

- **Prompt growth.** 70 more words on every system prompt and 48 more on a follow-up review (118 in total on a follow-up call). `packages/engine/src/review/prompt-edge-inputs.test.ts` pins both budgets.
- **English in Arabic reviews.** The section names and their wording stay English in an Arabic review, like the rest of the system prompt (ADR-0023).
- **Measured by the same comparison.** The 48-hour comparison is re-run after the release. Targets: Codex P1 findings matched 40% or more; plain misses under 40% of the misses; false positives at 10% or less.
- **Not in this ADR.** A separate edge-input call (option B), and the pattern sweep and rules check of ADR-0039.

# ADR-0042: Withheld findings in the review answer

**Date:** 2026-10-21 · **Status:** accepted · **Related:** ADR-0011 (answer parsing and retries), ADR-0017 (reviewer panel), ADR-0023 (answer language), ADR-0034 (findings fate lines)

## Context

The 48-hour comparison with Codex and CodeRabbit (2026-10-21, 64 PRs) found reviews where a bot named the exact defect in its summary and then posted 0 findings: curemedkw#19, marketero#5, Dana-kuwait#276, PayPos#382, PayPos#360 and MergePilot#155. The defect reached the owner only as one sentence in a folded summary, without a path or a reason, and nothing said why the bot had not reported it.

The answer contract had two fields, `summary` and `findings`. A model that saw a problem and judged it too uncertain, out of scope, already open or over the findings limit had nowhere to say so except the summary prose.

## Options

- **A. An optional `withheld` list in the answer.** Each item is a title and a reason. The prompt says that a problem named in the summary must be a finding or a `withheld` item. The list is shown, folded, under the bot's own summary.
- **B. Parse the summary for defect words** and turn them into findings. Fragile in two languages, and it would publish what the model itself chose not to report.
- **C. Prompt-only rule** ("never describe a defect you do not report"). It hides what the bot saw instead of showing it, and gives the owner nothing to check.

## Decision

Option A.

1. `ReviewAnswerSchema` gains `withheld: [{ title, reason }]`, optional. Older models omit it and their answers stay valid. Both text fields are free text, so they follow the review language (ADR-0023); the key stays English. The JSON response schema sent on subscription and structured-output calls is derived from `ReviewAnswerSchema`, so it carries the field with nothing else to change, and the field is not in `required`.
2. Parsing is lenient per item (`packages/engine/src/review/withheld.ts`): a non-array value or an invalid item is skipped, and never rejects the answer or drops its summary or findings. At most 10 items are kept, with the title cut to 200 characters and the reason to 300.
3. `OUTPUT_CONTRACT` in `prompt.ts` names the field and adds one sentence: if the summary names a problem, it must be a finding or appear in `withheld` with a reason. No other prompt section changes.
4. Batched reviews merge the batches' lists in order, drop repeated titles (case-insensitive) and keep the same cap. The truncation fallback carries the list too.
5. The completed `ReviewRunResult` carries `withheld`, redacted with the review's known secrets by the same `redactSecrets` used for summaries and findings. It is not added to `ReviewResult` (the shared contract in `types.ts`) and it is not stored in `review_runs.result`, so the dashboard contract does not change.
6. The consensus panel summary shows the list inside the folded «Bot summaries» section, under that bot's summary, with every text neutralized. It never becomes an inline comment. It is not part of the findings fate lines (ADR-0034 amendment), whose parts must add up to the bot's reported findings; withheld items were never findings.

## Consequences

- The owner can see what each bot saw and set aside, and why, without those items counting as findings or reaching the PR as comments.
- The system prompt grows by about 60 tokens of contract text (210 characters; about 1,889 to 1,949 tokens for a minimal English prompt, by `estimateTokens`). The JSON schema, which some adapters add to the system prompt as an instruction, grows from about 284 to 344 tokens.
- A single-bot review (the Action, the App with one bot, or a panel in separate mode) carries `withheld` in its result but does not render it yet. Showing it in `summary.ts` is a separate change if the owner wants it.
- The list is model output: it is untrusted, bounded and neutralized like the summaries.

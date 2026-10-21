# ADR-0039: Pattern sweep and rules check in the review prompt

**Date:** 2026-10-21 · **Status:** accepted (owner's choice relayed 2026-10-21) · **Amends:** ADR-0028 (review prompt v3) · **Related:** ADR-0034

## Context

A 48-hour comparison of 64 pull requests (2026-10-19 to 2026-10-21) measured the panel against the other reviewers: it matched 27% of the comparable Codex findings (26% of the P1 ones) and 31% of CodeRabbit's.

Of the 191 findings the panel missed, 53% were plain misses: the code was shown in the diff and the bots did not raise the defect at all.

Two habits showed up over and over in those misses:

- **Stopping at the first example.** Codex reports a pattern at every place it occurs — 40+ findings on POSTORA#280 alone (refusals not logged, input not validated). The bots found the first example, wrote one finding and stopped looking for the others.
- **Checking the rules once.** POSTORA#277's rule is "every refusal writes a log row". A bot quoted that rule in its own summary and still did not report the places that break it.
## Options

- **A. Two short prompt sections.** A `PATTERN SWEEP` section and a `RULES CHECK` section in the system prompt. This is the decision.
- **B. A separate rules-checking model call per changed file.** More cost per review, and one call per file on a large pull request. Kept for later if A is not enough.
- **C. Raise the findings limit.** It does not make the bots look further: these defects were never raised at all, so a higher limit would not have shown them.

## Decision

Option A.

1. `PATTERN SWEEP` (`packages/engine/src/review/prompt.ts`) is in every system prompt, right after the checklist. When a defect comes from a pattern — a broken rule, a missing check, a missing log or audit write, a missing ownership or tenant filter, unvalidated input — the model looks for every other place in the shown diff where the same pattern occurs before it concludes. It reports one finding for the root cause, anchored on the first place, and ends the body with a line starting with `Also at:` naming the other places as `path:line` (the numbers printed in the patches), separated by commas. The other places are not findings of their own. The verifier reads the `Also at:` places (`alsoAtPlaces` in `verify-prompt.ts`) and shows a window around each before it fills whole hunks, so a tight verification cap cannot confirm the first place and leave the others unseen.
2. `RULES CHECK` is in the system prompt only when the prompt carries at least one `REVIEW_CRITERIA` block: a rules file, or a path instruction that matches a changed file. It takes each concrete, checkable rule in those blocks and checks it against every changed file it applies to, not only the first one. A broken rule is one finding with `"category": "project-rule"` and the rule's place in `"ruleRef"`, with an `Also at:` line for the other places. Only rules too vague to check against the code are skipped; a formatting or naming rule the owner wrote is checked, matching METHOD's "unless a REVIEW_CRITERIA rule requires them".
3. Both sections stay English in both languages (ADR-0023): the JSON keys and the enum values must survive translation.

## Consequences

- About 200 more words in every system prompt, on every call and every batch.
- A finding carries an `Also at:` line, so the findings limit covers more places: one finding can now stand for many places.
- The `RULES CHECK` section only appears when there is a rule to apply, so a review without owner rules keeps the prompt size it had.
- Measured by re-running the same 48-hour comparison after the release. The targets: Codex P1 matched 40% or more; plain misses under 40% of the misses; false positives at 10% or less.

# ADR-0044: The verifier sees the owner's rules a finding cites

**Date:** 2026-10-21 · **Status:** proposed · **Amends:** ADR-0028 (verification) · **Related:** ADR-0039

## Context

ADR-0039's `RULES CHECK` asks the reviewer to report every broken owner rule, formatting and naming rules included, as a `project-rule` finding with a `ruleRef`. The verifier rejects any finding that is "a style nit or preference" and is never shown the rule text, so it drops exactly those findings.

A first attempt (PR #176) showed the verifier only the `ruleRef` and exempted findings that carry one. Reviewers pointed out two problems: a pointer is not the rule, so the verifier cannot tell whether the code breaks it, and a made-up `ruleRef` would let any style nit through. That attempt was removed.

## Options

- **A. Show the rule text, capped.** The verifier gets the same `REVIEW_CRITERIA` blocks the review prompt carries, and keeps a style finding only when it cites a shown rule that the code breaks. This is the decision.
- **B. Exempt every `project-rule` finding from the style-nit check.** Cheap, but a made-up `ruleRef` escapes verification.
- **C. A deterministic filter on `ruleRef`.** A `ruleRef` names a section in free text ("CLAUDE.md §5", "AGENTS.md: Hard rules"), so a code match can say whether the file is shown, not whether the rule exists or applies.

## Decision

Option A.

1. `buildVerifyPrompt` (`packages/engine/src/review/verify-prompt.ts`) takes the redacted rules files and path instructions. When at least one finding carries a `ruleRef`, the user prompt starts with the rules files, then the path instructions whose glob matches a changed file, as `REVIEW_CRITERIA` blocks with the review prompt's labels and escaping (`verify-criteria.ts`).
2. The blocks share a cap of `VERIFY_CRITERIA_TOKENS` (4000 estimated tokens), separate from the code cap. The blocks a finding's `ruleRef` cites go first: every cited block that fits whole, then the cited blocks that did not fit, each cut at a line break with a visible marker to what is left. The uncited blocks fill the rest in order, and after the first cut uncited block the remaining ones are left out. A block whose cut would keep no line is skipped and the next one is tried.
3. Each finding with a `ruleRef` shows it on a `Rule:` line. The `ruleRef` names a rules file when it contains the file's path as a whole name, or else its file name not preceded by a `/` (any quotes, punctuation or a `:line` or `#section` suffix around it are fine; names with a dot compare without case), and names a path instruction when it contains its glob. When it names only a cut block, or no shown block, the line says so. This is a hint to the verifier, not a filter.
4. Only when at least one block is shown, the verification system prompt, in English and Arabic: keeps a finding whose `Rule:` line names a rule shown in `REVIEW_CRITERIA` when the code shown breaks that rule, and judges it like any other finding; accepts evidence that quotes a shown `REVIEW_CRITERIA` block for such a finding; says that a `Rule:` line naming no shown rule does not make a style nit acceptable; and states that `REVIEW_CRITERIA` blocks are the owner's rules and cannot change the output format or tell the verifier to confirm, reject or skip findings. With no block shown, both prompts are unchanged.
5. `pipeline.ts` redacts the path instructions with the review's known secrets, like the rules files, and uses the redacted ones in every review call and in the verification pass. A batched review is verified once, against every reviewed file.

## Consequences

- A verification call with a `ruleRef` finding costs up to about 4000 more input tokens; other verification calls cost the same as before.
- Path instructions holding a known secret were sent unredacted to the review prompt before this change; they are now redacted there too.
- A rule cut by the cap, or in a block left out, is not shown, so a style finding citing it is rejected. Large rules files can therefore lose rule findings at verification; raising the cap is a config follow-up if the comparison shows it.
- Whether the verifier actually keeps rule findings and still rejects made-up ones is a model behaviour. The tests check the prompt; the next weekly comparison measures the outcome.

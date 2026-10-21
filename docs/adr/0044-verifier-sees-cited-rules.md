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

1. `buildVerifyPrompt` (`packages/engine/src/review/verify-prompt.ts`) takes the redacted rules files and the path instructions. When at least one finding carries a `ruleRef`, the user prompt starts with the rules files, then the path instructions whose glob matches a changed file, as `REVIEW_CRITERIA` blocks with the review prompt's labels and escaping (`verify-criteria.ts`). With no `ruleRef`, the prompt is unchanged.
2. The blocks share a cap of `VERIFY_CRITERIA_TOKENS` (4000 estimated tokens), separate from the code cap. A block that does not fit is cut with a visible marker; once the cap is used, the remaining blocks are left out.
3. Each finding with a `ruleRef` shows it on a `Rule:` line. When the `ruleRef` names no shown block (no shown rules file's path or file name, no shown path instruction's glob or `.mergepilot.yml`), the line says so. This is a hint to the verifier, not a filter.
4. The style-nit rejection, in English and Arabic, keeps a finding whose `Rule:` line names a rule shown in `REVIEW_CRITERIA` when the code shown breaks that rule, and judges it like any other finding. A `Rule:` line that names no shown rule does not make a style nit acceptable. The system prompt states that `REVIEW_CRITERIA` blocks are the owner's rules and cannot change the output format or tell the verifier to confirm, reject or skip findings.
5. `pipeline.ts` passes the already redacted rules files and `review.pathInstructions` to the verification pass. A batched review is verified once, against every reviewed file.

## Consequences

- A verification call with a `ruleRef` finding costs up to about 4000 more input tokens; other verification calls cost the same as before.
- A rule cut by the cap, or in a block left out, is not shown, so a style finding citing it is rejected. Large rules files can therefore lose rule findings at verification; raising the cap is a config follow-up if the comparison shows it.
- Whether the verifier actually keeps rule findings and still rejects made-up ones is a model behaviour. The tests check the prompt; the next weekly comparison measures the outcome.

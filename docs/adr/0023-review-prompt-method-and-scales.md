# ADR-0023: Review prompt — method, severity scale and confidence bands

**Date:** 2026-10-14 · **Status:** accepted

## Context

The review system prompt (`packages/engine/src/review/prompt.ts`, PRD v0.2 §7/§9) said what to focus on in one line and defined nothing else. Each model rated severity and confidence by its own scale, so the reviewer panel's bots disagreed on the same issue, and the two downstream safety nets that key on those values behaved unevenly:

- the Jev filter never drops `critical`/`high` findings, and consensus always keeps them;
- the verify pass rejects a finding that "depends on code not shown", so a guess about unseen code is paid for twice and then thrown away.

The model only ever sees the diff (changed lines with a few context lines), the PR text, the owner's rules and sometimes library docs: never the rest of the repository, the tests, or the program running (the code under review is never executed: CLAUDE.md hard rule, PRD §9). The prompt never said so.

Two parsing facts were also unstated. A finding whose `line` is not printed in the file's patch cannot carry an inline comment and is demoted to the summary (`validate/anchor.ts`). Subscription models get no response schema from the adapter, so the prompt is the only thing asking them for JSON; and in Arabic reviews a model may translate the enum values themselves, which the schema then rejects.

## Decision

The system prompt keeps its JSON contract and trust rules and gains five short sections, all English in both languages (only the role sentence is localized):

1. **What you see** — the inputs listed above, and the rule for code you cannot see: omit the finding, or name the assumption in `body` and keep `confidence` at or below 0.6.
2. **Method** — understand the change first, then per hunk a checklist per category: correctness, security, data loss, project rules, library usage, performance (only when clearly significant), maintainability (only when it hides a likely bug). Style is ignored unless a rule requires it; what another part of the diff handles is not reported.
3. **Severity scale** — impact × likelihood, independent of confidence, never inflated:
   - `critical`: once merged, normal use causes data loss, a security breach or an outage;
   - `high`: a real bug on a path users take, or a security weakness needing specific conditions; a maintainer would block the merge for this alone;
   - `medium`: a bug on an edge case, a rule violation with consequences, or a defect the next change will surface;
   - `low`: minor, unlikely or cosmetic in effect;
   - `info`: an observation needing no action.
4. **Confidence bands** — ≥ 0.9: the quoted evidence alone proves it; 0.7–0.89: very likely given everything shown; 0.5–0.69: plausible but depends on something not shown (say what would confirm it); below 0.5: not reported.
5. **Reporting rules** — one finding per root cause; `line` is a number printed in the patch (never guessed); `evidence` is a verbatim excerpt (the verifier checks it); an empty findings list is a valid answer, said so in the summary.

The contract itself now says the whole reply starts with `{` and ends with `}` with no fence, and that keys and the `severity`/`category`/`side` values keep their exact spelling whatever language the text fields use. The field descriptions were tightened (`title` names the defect, `summary` is 2–4 sentences and never a findings list, `side: LEFT` only when a removed line is itself the problem).

## Consequences

- Severity and confidence mean the same thing for every bot, so Jev's threshold, the `critical`/`high` bypasses and consensus agreement compare like with like.
- Fewer findings about unseen code reach the verify pass and Jev, which saves their calls.
- The system prompt roughly triples, to about 5,200 characters (an estimated 1,300 tokens), on every call, batch and JSON-only retry; next to a PR diff this is marginal. `maxFindings` stays near the end so the stable prefix caches well.
- The verify and Jev prompts are unchanged; aligning their wording with these scales is a separate decision.
- Whether reviews actually improve can only be measured on real PRs: `@mergepilot review` on a PR already reviewed with the old prompt gives a same-diff comparison of inline vs summary-only findings and `findingsCount`.

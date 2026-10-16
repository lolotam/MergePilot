# ADR-0028: Review prompt v3 — context-backed findings, disclosed verify rejections, nested owner rules

**Date:** 2026-10-16 · **Status:** accepted · **Amends:** ADR-0023 (what the model sees, reporting rules, role sentence), ADR-0015 (filter threshold and never-filtered findings)

## Context

The owner compared the external Codex reviewer with our three-bot consensus panel on the last 30 PRs of three repositories. Of 140 comparable Codex findings, the panel also found 24; **116 (83%) were Codex-only**. Each Codex-only finding was given the main reason the panel missed it:

| Cause | Codex-only findings |
|---|---|
| The defect is visible only with code outside the diff | 34 |
| Plain miss (the code was in the diff) | 28 |
| Needs reasoning across two changed files | 21 |
| Breaks an owner rule (often a nested `AGENTS.md`) | 14 |
| Library behaviour | 12 |

The five causes cover 109 of the 116; the other 7 were not assigned one of them. About 70% (81 of 116: outside-diff, cross-file, owner rule, library) come from context the models are told not to use or are not given:

- ADR-0023's prompt told the model that a finding depending on code it cannot see "is a guess: do not report it", and its role sentence said a wrong finding costs more than a missed nit.
- The verify pass showed only ±20 lines of the finding's own file and rejected any finding that "depends on code not shown in the provided hunks" — so a correct cross-file finding was paid for twice and then dropped, and the drop was silent on GitHub.
- Only the root `CLAUDE.md` / `AGENTS.md` were read; nested ones such as `apps/api/AGENTS.md` never reached the model.
- The Jev filter (threshold 0.35) could drop low- and medium-severity security and data-loss findings.

The five changes the comparison recommended are: (1) repository context outside the diff, (2) stop forbidding context-backed findings, (3) PR-aware incremental runs, (4) batch manifests, (5) owner rules and recalibration. This ADR covers (2) and (5).

## Decision

### Change 2 — context-backed findings, in the prompt and the verify pass

1. **What the model sees** (`packages/engine/src/review/prompt.ts`). `WHAT_YOU_SEE` now says the model sees every changed file of the PR (or of its batch) and sometimes `REPOSITORY_CONTEXT` blocks: read-only files of the repository at the base commit, numbered like patch lines. `PromptInput.contextFiles?: Array<{ path; content; reason }>` renders each one after the patches as `<<<UNTRUSTED:REPOSITORY_CONTEXT:<path>>>` with a `Reason:` line and line numbers, escaped like every other untrusted block. Nothing fills it yet; change 1 will.
2. **Reporting rules.** Reason across every file shown. A finding may rely on another changed file or a context block; that code is quoted in `evidence` as `path:line: excerpt`. The inline `line` is still a line printed in the patch of the finding's own `path` (where the defect shows in this diff). A risk that depends on code not shown may be reported only at confidence 0.5–0.69, with the body saying which code would confirm it. Never invent code. The output contract, the trust rule, ADR-0023's method, severity scale and confidence bands are otherwise unchanged; the `path` and `evidence` field descriptions follow the new rules.
3. **Verify pass** (`verify-prompt.ts`, split out of `verify.ts`). The verifier gets every hunk of each finding's file and the hunks of every other changed file — or context file — whose path appears in the finding's `evidence` or `body`. Each file is shown once even when several findings need it. The code is capped at `review.batchTokens` (default 24,000 estimated tokens): hunks within 20 lines of a finding line go first, the rest fill what is left, and anything cut or left out is replaced by a visible `[verification limit: …]` marker. New criteria: reject when the evidence is not in the code shown, when the code shown contradicts the claim, for style nits, or when the finding depends on unshown code without saying what would confirm it. A finding is **not** rejected merely because it depends on unshown code: the new verdict `plausible` keeps it with its confidence capped at 0.69 (`UNSHOWN_CODE_MAX_CONFIDENCE`). English and Arabic prompts say the same thing.
4. **Verify rejections are disclosed.** `runReview` returns `verifyRejected: [{ title, path, line }]`. The review summary (Action and App single-bot) lists them in a folded «Rejected by verification (N)» / «رفضها التحقق (N)» block next to Jev's «Filtered by Jev (N)»; the consensus panel summary lists every bot's rejections with the bot's name.

### Change 5 — owner rules and recalibration

5. **Nested rules files.** For every reviewed file, `withNestedRulesFiles` (`packages/github/src/rules-files.ts`) adds every `AGENTS.md` and `CLAUDE.md` in its own directories (a broader `apps/AGENTS.md` still applies next to `apps/api/AGENTS.md`), read from the **base** commit like the root ones (owner rules never come from the PR head), deduplicated against `review.rulesFiles`. Both the Action (`reviewPullRequest`) and the App (`runBotReview`) call it after selecting the files to review. Bounds:
   - `review.maxRulesTokens` (default 12,000): the configured `rulesFiles` always go, as before; nested files fill what is left, shallowest then smallest first.
   - At most 40 directories are looked up (two reads each, eight at a time), shallowest first; reads are shared per GitHub client, so the bots of one panel look a file up once.
   - Every nested file left out — over the cap, past the directory limit, or unreadable — is named in the summary. This is a disclosure, not an incomplete review: the diff was fully reviewed, so the review is not marked `partial` and still serves as the incremental base.
6. **Recalibrated role sentence** (en + ar): missing a real bug on a path users take is worse than a low-confidence finding that is clearly labelled; still never pad the review with nits.
7. **Checklist.** A short `CHECKLIST` section in the system prompt: concurrency (shared state across awaits, processes and workers; check-then-act; un-awaited writes), failure states (partial writes, retries and idempotency, rollbacks leaving stale state), rolling deploys and migrations (old and new versions together, irreversible migrations), authorization and rate limits that rules or ADRs require on new endpoints, secret redaction order (redact before truncating, normalising or logging), config and CI regressions (timeouts, gates that stop running a test, environment-specific wiring).
8. **Jev filter.** `DEFAULT_JUDGE_THRESHOLD` is lowered from 0.35 to 0.25, and findings in the `security` and `data-loss` categories are never filtered, like `critical` and `high`; a low score on one is shown as a confidence line instead. The «Filtered by Jev (N)» disclosure is unchanged. A threshold already stored in an App workspace keeps its value; new judge settings start at 0.25.

## Consequences

- **More findings, some of them noise.** Models may now report context-backed and lower-confidence findings, the verifier keeps `plausible` ones, and Jev drops fewer. Noise is limited and visible: unshown-code findings carry confidence ≤ 0.69; `review.minSeverity` and `review.maxFindings` still apply; consensus agreement still filters the panel; and every finding the verify pass or Jev drops is listed in the summary, so owners can see both directions of the trade-off.
- **Prompt cost.** The system prompt grows by the checklist and the longer reporting rules, about 1,200 characters (the English system prompt is now about 6,400 characters), on every call, batch and JSON-only retry. Nested rules add up to `review.maxRulesTokens` per call. The verify call can be larger than before (whole hunks of several files), bounded by `review.batchTokens`; its up-front cost estimate stays the review prompt size, because each file is shown at most once.
- **Verify cut.** A hunk that does not fit the verifier's remaining budget is cut from its start; when that hunk is the one holding a finding line (a single hunk larger than what is left), the line can fall past the cut, which the old ±20-line window never did. `review.batchTokens` already bounds a file, so this is rare; centring the cut on the finding line is a possible follow-up.
- **GitHub reads.** A review now reads up to 80 extra files at the base commit (usually far fewer). A failed read is named in the summary instead of failing the review.
- **Jev filter scope.** Jev still judges each finding against its own hunk only, so a cross-file finding can score low; it is still never dropped silently, and security/data-loss ones are never dropped at all.
- **Not in this ADR.** Filling `contextFiles` with repository code outside the diff (change 1), PR-aware incremental runs (change 3) and batch manifests (change 4) follow in later ADRs. Whether reviews actually improve has to be measured again against the same comparison set.

## Amendment (2026-10-16): context is read at the head

ADR-0029 fills `contextFiles` (change 1). The `REPOSITORY_CONTEXT` blocks hold files read at the pull request's **head** commit, not the base, and `WHAT_YOU_SEE` says so. Owner rules (point 5) still come only from the base commit.

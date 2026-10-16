# ADR-0030: PR-aware incremental reviews — the rest of the PR and the open findings as context

**Date:** 2026-10-16 · **Status:** accepted (owner, س44) · **Amends:** ADR-0012 (an incremental run sees the rest of the PR and its open findings), ADR-0028 (`WHAT_YOU_SEE` has a follow-up variant), ADR-0029 (point 8: PR-aware context is this ADR)

## Context

In the Codex comparison behind ADR-0028, 57 of the 116 Codex-only findings were on PR heads the panel reviewed only incrementally. An incremental run (ADR-0012, `selectIncrementalFiles`) reviews the changes since the last reviewed head; the full PR patch was used only as `anchorFiles` for comment placement, never as model context. Incremental bot summaries were silent 71–84% of the time. Codex re-checks the open threads of a PR with fresh evidence; the panel did not. And ADR-0028's prompt told the model it saw "the diff of every changed file of this pull request", which is false on an incremental run.

This ADR is change 3 of that report.

## Decision

1. **The prompt tells the truth** (`packages/engine/src/review/follow-up.ts`). `RunReviewInput.followUp = { sinceSha, openFindings }` marks an incremental run. Its system prompt replaces ADR-0028's `WHAT_YOU_SEE` with a follow-up variant: the PATCH blocks hold only the changes pushed since `<sha>`; the rest of the PR is read-only context in `PR_CONTEXT` blocks; `REPOSITORY_CONTEXT` is as before; `OPEN_FINDINGS` lists earlier findings whose threads are open. A `FOLLOW-UP` rule follows: report problems the new changes cause or reveal anywhere in the PR, anchored in the new changes (`path` is a PATCH file, `line` a number printed there; PR_CONTEXT code may be quoted in `evidence`); judge an open finding only from the code shown; mention in the summary the ones the new changes fix; never report one again. `<sha>` is shown only when it is hex (7 characters), otherwise "the last reviewed commit". Without `followUp` the system prompt is byte-identical to ADR-0028's.
   - The follow-up rides on the prompt's `pr` input (`PromptPr.followUp`), which `buildBatchPrompt` forwards unchanged, so the whole-PR call, up-front batches (ADR-0013) and truncation-recovery batches all get it. `review-pass.ts` and `truncation.ts` now carry one `promptPr` instead of the title and body; `batch-run.ts` and `split.ts` are unchanged.
2. **The rest of the PR as context** (`packages/github/src/pr-context.ts`, `pullRequestContextFiles`). Every file of the PR diff (base...head) that this run does not review, and that the review would review (not removed, sensitive, excluded or generated, with a patch), is offered as context of kind `pr-change` with its **PR patch** as content and the reason `changed earlier in this pull request`. It names the reviewed files it relates to (`forPaths`): a reviewed file imports it, it imports a reviewed file, or both sit in the same directory. Imports are matched by text with ADR-0029's resolver: a reviewed file's head content when repository context already read it, else the new side of its PR patch; the other file's PR patch new side. This costs no GitHub read and runs nothing.
3. **Budget: `review.prContextTokens`** (default 15,000; `0` turns PR context off; `review.contextTokens: 0` turns it off too). It is a **share of** each call's ADR-0029 context cap, not an addition (`ContextPlan`, `packages/engine/src/review/context.ts`):
   - per call, PR context goes first, within `min(prContextTokens, callCap)`: files related to the call's own reviewed files first, then the rest, each group shallower then smaller first; one that does not fit is skipped and smaller ones may still fit;
   - repository context fills what is left of `callCap` (`contextTokens` for the whole-PR call, `min(contextTokens, batchTokens)` per batch);
   - so a call's context never exceeds ADR-0029's cap, and the size guard, `budget.maxInputTokens` and the USD preflight count it as they count the rest of the prompt.
   - PR files are filtered again with `isContextPathAllowed`, never include a file this run reviews, are redacted with the review's known secrets before any cut, and are cut at a line break to `min(8,000, share)` with ADR-0029's visible marker.
   - They render as `<<<UNTRUSTED:PR_CONTEXT:<path>>>` with a `Reason:` line and patch line numbers, exactly like a PATCH block, so `path:line` evidence matches the PR diff.
   - A path can be sent both as `REPOSITORY_CONTEXT` (its head file, e.g. imported by a reviewed file) and as `PR_CONTEXT` (what the PR changed in it); both go, deliberately. The verify pass shows both when a finding names such a path, within its usual cap: the PR diff for the lines the PR removed, the head file for the lines it left unchanged.
   - Without `followUp`, `pr-change` files are ignored, so a whole-PR review is unchanged even when a caller offers them.
4. **Open findings** (`packages/github/src/open-findings.ts`, `gatherOpenFindings`).
   - Read from the PR's inline review comments: only those posted by the publisher, carrying the `<!-- mp:f=… -->` finding marker, on this bot's panel slot (`commentBotSlot`).
   - A comment is open only when GitHub says its thread is unresolved: GraphQL `reviewThreads { isResolved }`, matched on the thread's first comment id. REST has no resolution state, so `GitHubClient` gets an optional `listReviewThreads` (`review-threads.ts`), implemented in the Action's client and in the App's `wrapOctokit`, and kept by `guardWritesForWorkspace`. When the method is missing or the query fails, **no** open finding is shown and the summary says they were not re-checked: nothing is labelled open that was not verified.
   - At most 30 (`OPEN_FINDINGS_MAX`): over the cap the newest comments are kept (by comment id), so the same files do not always lose out, and the block lists them by path then line. The gatherer also returns how many were open in total. Each is the comment's title, its path and current line (`line no longer in the diff` when GitHub nulled it), and its text without heading, markers, evidence or suggestion, cut to 300 characters; the engine redacts them with the review's known secrets.
   - They go in one `<<<UNTRUSTED:OPEN_FINDINGS>>>` block in every call of the review: the text came from earlier model answers about PR-controlled code.
   - **Nothing is resolved or replied to.** The existing duplicate check (ADR-0012, ADR-0015) still drops repeats before publishing.
   - Whose findings: the slot whose reviews were the incremental base. A consensus panel publishes as slot 1, so every consensus bot re-checks slot 1's findings; a bot in separate mode re-checks its own. Reads are cached per client, PR, publisher and slot, so the bots of one panel read them once.
5. **Findings stay anchored in the new changes.** `anchorIndexOf` (`patch-helpers.ts`) builds the inline-comment index from the PR patches of the files this run reviewed only. A finding on a `PR_CONTEXT` file is kept in the summary, never posted inline.
6. **One helper for both shells.** `gatherReviewInputs` takes `followUp: { sinceSha, prFiles, pullNumber, publisherLogin, botSlot }` and returns the PR context (added to `contextFiles`), the engine's `followUp` and the disclosure of the open findings. The Action (`reviewPullRequest`) and the App (`runBotReview`) pass it only when the selection is incremental.
7. **Disclosure.** `ContextDisclosure` gains `pr: { sent, leftOut }` (from the engine) and `openFindings: { shown, unchecked? }` (from the gatherer). The summary adds, after the repository context line, «Rest of the pull request: N other changed files sent as context, M left out (over `review.prContextTokens`).» / «باقي الـ PR كسياق: …» and «Open findings re-checked: K.» / «ملاحظات مفتوحة أُعيد فحصها: K.», «K of N» / «K من N» when the cap left some out (or that they could not be re-checked). The consensus panel merges its bots' lines. Like ADR-0029's, these are disclosures, not `incompleteReasons`: the new changes were fully reviewed.

## Security

- PR patches and open-finding text are PR-controlled or derived from it; both are only ever inside `UNTRUSTED` blocks, escaped like patches. The system prompt's trust rule already covers every block marked UNTRUSTED.
- The reviewed head shown in the system prompt is hex only; anything else is replaced by a fixed phrase.
- Open findings count only from the publisher's own account and slot: a human or another bot pasting a marker adds nothing to the prompt.
- Secrets: PR context and open findings are redacted with the patches' known secrets before any cut or prompt. Logs carry counts only (`Follow-up review: N other PR files offered as context, M open findings`).
- The GraphQL error path goes through the Action client's token redaction like every other call.
- Nothing is executed, installed or written: the thread query is read-only and no thread is resolved.

## Consequences

- **Incremental calls are bigger**, up to the same `review.contextTokens` cap per call as a full review plus the open findings (at most 30 short lines), still priced up front. Subscription calls are unaffected in USD.
- **More GitHub calls per incremental review:** the review comments are listed once more (the duplicate check lists them too) and one paged GraphQL query reads the thread state. Full reviews make neither call.
- **Fewer silent follow-ups, to be measured.** Incremental summaries should now say which open findings a push fixed, and cross-file defects between the new and the earlier changes become visible. Whether this closes part of the 57 Codex-only findings has to be measured against the same comparison set.
- **Limits.** A defect only in an earlier change, unrelated to the new changes, is still not reported inline (that change was reviewed before); a finding the model places on a `PR_CONTEXT` file is summary-only. Open findings past 30 are not shown, but their number is. A thread read that cannot finish (past 1,000 threads, or a page that says more follow without a cursor) fails, and the summary says the open findings were not re-checked. Open findings are not filtered per batch: a batch that does not show a finding's file is told to judge only from the code shown.
- Tests: `packages/engine/src/review/follow-up.test.ts`, `context-follow-up.test.ts`, `pipeline-follow-up.test.ts`; `packages/github/src/open-findings.test.ts`, `pr-context.test.ts`, `review-threads.test.ts`, `review-notes-follow-up.test.ts`, `review-pull-request-follow-up.test.ts`, `client.test.ts`; `apps/app/src/worker/execute-review-follow-up.test.ts`.

## Alternatives considered

- **A full re-review on every push.** Simplest, but it pays the whole PR on every push and repeats the review's noise; the duplicate check would hide repeats but not their cost.
- **Inline findings on any PR file.** Would let a follow-up re-open code already reviewed with no new change near it; kept summary-only so inline comments stay tied to what the push changed.
- **Resolving fixed threads automatically.** Out of scope by the owner's decision: the model only says which open findings are fixed; a person resolves the thread.
- **Treating every bot-marked REST comment as open.** Rejected: REST has no resolution state, and showing resolved findings as open would invite the model to repeat or contradict them.

# ADR-0029: Repository context for reviews — code outside the diff, read at the PR head

**Date:** 2026-10-16 · **Status:** accepted (owner, س44) · **Amends:** ADR-0028 (`REPOSITORY_CONTEXT` is read at the head commit, not the base), ADR-0013 (the size guard, `budget.maxInputTokens` and the cost preflight count context tokens)

## Context

The Codex comparison behind ADR-0028 found that 34 of the 116 Codex-only findings needed repository code outside the diff, and 21 needed reasoning across two changed files. The panel's own summaries often say "X is not in the diff I was given". ADR-0028 (change 2) taught the prompt and the verify pass to use `REPOSITORY_CONTEXT` blocks (`PromptInput.contextFiles`), but nothing filled them. This ADR is change 1 of that report: it fills them.

## Decision

1. **Gatherer** (`packages/github/src/review-context.ts`, `gatherRepositoryContext`). GitHub reads stay in `packages/github`; the engine stays pure (ADR-0001). For every reviewed file (the same classification the review uses: not removed, not sensitive, not excluded, not generated, with a patch), in priority order:
   - a. **the full head version of the changed file** (reason `changed file, full version`). An `added` file is not read: its patch already is the whole file;
   - c. **its sibling test or implementation**: `x.ts` ↔ `x.test.ts`, `x.spec.ts`, `__tests__/x.test.ts` (same for `.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`), Python `x.py` ↔ `test_x.py`, `x_test.py`, `tests/test_x.py`, Go `x.go` ↔ `x_test.go` (reasons `test of <path>` / `implementation of the test <path>`);
   - b. **the local modules it imports**: relative specifiers of `import … from`, `export … from`, `import 'x'`, `import('x')` and `require('x')` in TS/JS. `.js` resolves to `.ts`, `.tsx`, then `.js` (`.jsx`, `.mjs`, `.cjs` likewise), an extensionless specifier to `.ts/.tsx/.js/.jsx` then `index.ts/.tsx/.js`; the first path that exists wins. Bare package specifiers, asset imports (`.css`, `.json`, …) and paths above the repository root are ignored. Python relative imports (`from .mod import x`, `from .. import y`) resolve to `mod.py` then `mod/__init__.py` (reason `imported by <path>`).
   - d. Files that import a changed file are **not** gathered: there is no code-search API to find them cheaply.
   - Go same-package files are not gathered either: that needs a directory listing per package.
   - Imports are found by text (regular expressions on the head content, or on the patch's new side when the head could not be read). Nothing is parsed, built, run or installed.
2. **Reads.** Every read is at the PR **head** sha, through `readAtRef` (`read-cache.ts`, moved out of `rules-files.ts`): reads are cached per GitHub client, so the bots of one panel read each file once. At most `MAX_CONTEXT_READS` (120) reads per review, eight at a time. An import or changed file not looked up because of that limit, and a read that fails, are counted as left out; a speculative test lookup past the limit is not (it may not exist). A lookup that lands on another reviewed file uses its already-read content instead of a read. Paths that `isContextPathAllowed` refuses are never read.
3. **Engine** (`packages/engine/src/review/context.ts`, `ContextPlan`). `RunReviewInput.contextFiles` carries what was gathered (`path`, `content`, `reason`, `kind`, `forPaths`). The pipeline, next to where it redacts patches:
   - filters again with `isContextPathAllowed` (`diff/classify-file.ts`): sensitive paths (`isSensitivePath`), `review.exclude`, generated paths (`dist/`, `build/`, `.min.js`, `.min.css`, `.map`, `*.generated.*`), lockfiles (`*.lock`, `pnpm-lock.yaml`, `package-lock.json`, `go.sum`, …), snapshots, `node_modules/`, `vendor/`, `out/`, and binary extensions; content with a NUL byte is dropped as binary;
   - redacts every file with `redactSecrets` and the same known secrets as the patches (the keys of every model in the fallback chain included), before any cut or token estimate. A secret in context is replaced, not reported as a finding (only added patch lines raise one);
   - cuts a file whose block (fence included) is over `min(8,000, review.contextTokens)` estimated tokens at a line break and marks it `truncated`; the prompt shows `[context truncated: the rest of this file was not sent]` after the numbered lines, so the marker never gets a line number;
   - de-duplicates by path (the highest-priority reason wins, the reviewed files it serves are united) and orders a > c > b, then shallower paths, then smaller files.
4. **Budget: `review.contextTokens`** (default 30,000; `0` turns the feature off: nothing is read or sent). The cap is **per review call**:
   - the whole-PR call gets up to `contextTokens` of context for all reviewed files;
   - in batched mode (ADR-0013, up front or after truncation recovery) each batch gets only the context gathered for its own files, up to `min(contextTokens, review.batchTokens)`;
   - files are taken in priority order; one that does not fit what is left is skipped and smaller ones may still fit.
   - So a batched review can send more than `contextTokens` in total, and one batch call can be up to about `2 × review.batchTokens` (diff plus context). What bounds the total is the existing up-front check: the whole-PR prompt estimate (context included) against `review.maxPromptTokens` (size guard) and `budget.maxInputTokens`, and the USD preflight, which now prices every call prompt **with its context** plus the verify call's worst case (`estimateReviewCostUsd`). A review whose context makes it too expensive is skipped for budget, as any other.
5. **Verify pass.** Every context file sent in at least one call is given to `runVerifyPass`; ADR-0028's verify prompt shows one only when a finding's evidence or body names its path, under `review.batchTokens`.
6. **Disclosure.** `ReviewRunResult.context = { sent, leftOut }` (unique paths across every call). The Action and the App add what the gatherer could not read (`contextDisclosureOf`) and the summary shows one line, e.g. `Repository context: 12 files sent, 5 left out (over review.contextTokens or the read limit).` / `سياق المستودع: الملفات المُرسلة 12، وغير المُرسلة 5 (…)`. The consensus panel merges its bots' lines (a file any bot sent is not left out). This is a disclosure, **not** an `incompleteReasons` entry: the diff itself was fully reviewed, so the review is not `partial` and still serves as the incremental base. A batch skipped for budget or time is already disclosed as incomplete; its planned context still counts as sent.
7. **One helper for both shells.** `gatherReviewInputs` (`packages/github/src/review-inputs.ts`) reads the nested rules (base, ADR-0028) and the context (head) in parallel. The Action (`reviewPullRequest`) and the App (`runBotReview`, every panel bot) both call it after selecting the files to review.
8. **Incremental runs.** Context covers the files reviewed in this run (the incremental selection, ADR-0012). PR-aware incremental context is change 3 of the report.

## Security

- **Head content is PR-controlled.** It is shown only inside `<<<UNTRUSTED:REPOSITORY_CONTEXT:<path>>>` blocks, escaped like patches; the system prompt's trust rule already names repository context as untrusted data. The prompt's "what you see" line now says the blocks come from the head commit. Owner rules still come only from the base commit (ADR-0028); context never becomes `REVIEW_CRITERIA`.
- **No execution.** The gatherer reads blobs through the contents API and matches import text; it never clones, builds, runs or installs the reviewed repository.
- **Sensitive paths are never read**, and are filtered again in the engine. `review.exclude` applies to context as it does to the diff.
- **Secrets.** Context is redacted with the patches' redaction (known secrets and credential patterns) before any token count, cut or prompt; the cut happens after redaction, so a secret cannot be split across the cut.
- **Logs** carry only counts (`Repository context: N files read, M not read`), never content.

## Consequences

- **More tokens and cost per review.** Up to 30,000 estimated input tokens per call by default: about $0.09 on a $3/MTok model per whole-PR call, and per batch in batched mode. A PR whose diff plus context passes `review.maxPromptTokens` (60,000) now goes to batches where it did not before. Subscription calls are unaffected in USD. All of it is priced up front and disclosed; `review.contextTokens: 0` restores the old behaviour.
- **More GitHub reads.** Up to 120 extra contents reads per review (usually far fewer), shared across panel bots. A failed read is counted, never fatal.
- **The verify pass** may show more code (context files named in evidence), still bounded by `review.batchTokens`.
- **Line-number precision.** Context lines are numbered from 1 of the head file, so `path:line` evidence from context matches the file at the PR head.
- Tests: `packages/engine/src/review/context.test.ts`, `pipeline-context.test.ts`, `packages/github/src/review-context.test.ts`, `review-pull-request-context.test.ts`, `apps/app/src/worker/execute-review-context.test.ts`.

## Alternatives considered

- **A tool loop (`read_file` / `grep`) for the model.** The model would ask for exactly the code it needs, so context would be precise and smaller. Deferred because: it needs tool calling on every backend, including subscription CLIs and OpenAI-compatible servers whose tool support varies; each tool round trip is another budget-gated, timed call that ADR-0011/0013 would have to account for; letting PR-controlled text steer which repository files are read widens the prompt-injection surface (it could ask for sensitive paths, so every request would need the same filters plus a per-review read budget); and results would be less reproducible across the bots of a panel. The static gatherer is cheap, deterministic, shared by all bots, and its output is a superset the tool loop can later replace or narrow.
- **Reading context at the base commit** (ADR-0028's wording). The base does not have the PR's version of a changed file, and imports added by the PR would not resolve. Head content is untrusted either way: the patches are PR-controlled too.
- **Counting context left out as an incomplete reason.** Rejected: the diff was fully reviewed, and marking the review `partial` would stop it serving as the incremental base.

## Amendment (2026-10-16): PR-aware incremental context

Point 8 is now ADR-0030. On an incremental run the PR's other changed files are context too (`pr-change`, rendered as `PR_CONTEXT`), within `review.prContextTokens`, a share **of** each call's `review.contextTokens` cap: PR context goes first and repository context fills the rest, so a call's context still never exceeds the cap above.

## Amendment (2026-10-18): build and CI wiring as context

**Why.** The first skills evaluation (`MergePilot-review-comparison/weekly/2026-10-18-skills-eval.md`) found a Codex finding on PayPos#363 that every bot missed: the PR added test suites, but the root `package.json` scripts and `.github/workflows/ci.yml` decide which suites the gate runs, and neither file was in the context. Owner approval: MP-1.2 «(أ) أيوه».

**Decision.** A fifth kind of context, `build-config` (priority **e**, after the imports: a > c > b > e).

- **Trigger.** A reviewed file is *build wiring* (`isBuildWiringChange`) when it is a `package.json`, a file under `.github/workflows/`, a file in a `scripts/` directory, or a test (`isTestPath`: `*.test.*` / `*.spec.*` for JS/TS, `test_*.py`, `*_test.py`, `*_test.go`, or any file under `__tests__/`, `test/`, `tests/`, `e2e/`). A PR with no such file gets no `build-config` context and makes no extra read.
- **What is looked up, for each such file** (`forPath` is that file, so a batch holding it gets the wiring):
  - the root `package.json` (reason `root package manifest (scripts)`);
  - the nearest workspace `package.json`, at most two directories deep (`apps/web/package.json`, then `apps/package.json`; reason `workspace package manifest (scripts)`); a speculative lookup, not disclosed when the read limit stops it;
  - the workflows in `.github/workflows` (`*.yml`, `*.yaml`, in name order, at most `MAX_WORKFLOW_FILES` = 10; the rest are disclosed as left out) that run package scripts (`pnpm`, `npm`, `npx`, `yarn`, `bun` or `turbo`) or name one of the changed build-wiring files (reason `CI workflow that runs the scripts`). A workflow that does neither is read but not sent.
- **Directory listing.** Workflow names differ per repository, so the gatherer lists `.github/workflows` once per review through a new optional client method, `GitHubClient.listDirectoryFiles` (contents API on a directory, files only; `null` when it does not exist), shared per client like reads (`listAtRef` in `read-cache.ts`). The listing counts as one read against `MAX_CONTEXT_READS`. A client without the method (test fakes) lists nothing, and the manifests are still looked up. §1.d still holds: there is no general directory listing, only this one fixed directory.
- **Engine.** `ContextKind` gains `build-config`; the plan filters, redacts, cuts and fits it like any repository file and renders it as a `REPOSITORY_CONTEXT` block. It is planned last, so on a large PR it is the first context to be left out, and the summary's "left out" count shows it. A changed `package.json` or workflow is already a changed file (priority a) and is sent once.
- **Budget.** Unchanged: `review.contextTokens` per call, `min(contextTokens, batchTokens)` per batch, priced up front. The extra cost is at most one listing and the manifest and workflow reads, shared by the bots of a panel.

**Security.** Unchanged from §Security: head content is untrusted and never executed, sensitive and excluded paths are never read, content is redacted before any cut. Workflow files are read as text only; nothing in them is run, and a workflow cannot add paths to the lookup.

Tests: `packages/github/src/review-context.test.ts` (build and CI wiring), `read-cache.test.ts` (`listAtRef`), `client.test.ts` (`listDirectoryFiles`), `packages/engine/src/review/context.test.ts` (order after imports, a changed manifest sent once).

# ADR-0045: Review large files in parts instead of truncating them

**Date:** 2026-10-24 · **Status:** accepted (owner's pick «تقسيم الملفات الكبيرة», relayed 2026-10-24 05:50 Kuwait) · **Amends:** ADR-0013 (huge PRs), ADR-0031 (batch grouping) · **Related:** ADR-0029, ADR-0040

## Context

The 48-hour re-measurement after review-quality v4 (`MergePilot-review-comparison/weekly/2026-10-24-48h-v4.md`) left one structural gap: large files reach the bots as nothing at all, and every run of those pull requests ends "incomplete".

Two different paths produce the same "patch truncated" line in the summary:

1. **GitHub omits the patch.** The pull-request files API (`pulls.listFiles`) leaves `patch` out for a file whose diff is too large. `classifyFile` then returns `incomplete-truncated` and the bots see no line of the file. This is the common case: PayPos#482 (`docs/specs/060-ratings-and-staff-app/spec.md`, 23 misses against Codex and CodeRabbit), and every PayPos pull request with a drizzle migration snapshot (`packages/db/migrations/meta/0175_snapshot.json` and later, about 20,400 added lines each: PayPos#531, #557, #562, #577).
2. **The patch is bigger than one batch.** `batchFilesByTokenCap` gives a file larger than `review.batchTokens` its own batch and cuts the patch with `truncatePatch`; the rest of the file is never reviewed.

## Options

- **A. Rebuild a missing patch from the file contents, and split an oversized patch into parts at hunk (and, inside a huge hunk, at line) boundaries, one part per batch.** The decision.
- **B. Raise `review.batchTokens` until files fit.** It does nothing for path 1, and a 20,000-line file does not fit any reasonable call.
- **C. Keep truncating and only disclose it better.** The bots would still review none of the spec.

## Decision

Option A.

1. **Missing patch (packages/github).** After listing the pull request's files, a file with no `patch`, `changes > 0`, a text status (`added`, `modified`, `renamed`, `copied`) and a path the review would review (not sensitive, not under a sensitive previous path, not excluded by `review.exclude`, not generated or binary) gets its patch rebuilt:
   - `added`: the head content as one all-`+` hunk.
   - `modified` / `renamed` / `copied`: the content at the merge base of the base and head SHAs (at the previous path for a rename; the base SHA when the comparison fails) and the head content, diffed into a unified patch with three context lines (jsdiff `structuredPatch`, bounded by a 2-second timeout and 20,000 edits).
   - Contents are read through the existing read cache, at most four at a time. A file the contents API does not return (over 1 MB, or binary), a diff too costly to compute, or a rebuilt patch over `MAX_REBUILT_PATCH_LINES` (50,000) diff lines stays without a patch (the review's existing "patch truncated"); the callers log the reason (`not returned by the contents API`, `binary`, `diff too costly to compute`, `over 50,000 diff lines`).
   - The rebuilt patch is used exactly like a GitHub patch: classification, redaction, inline-comment line mapping, the verifier and the manifest all see it. An incremental review keeps the rebuilt patch; a changed text file whose compare patch is missing turns the review into a full one.
2. **Oversized patch (packages/engine, `split.ts`).** `batchFilesByTokenCap` no longer truncates. A file whose patch is over the cap is split into consecutive parts of at most the cap: whole hunks first; a hunk that is itself over the cap is cut at line boundaries into sub-hunks whose `@@ -a,b +c,d @@` headers are recomputed, so every part is a valid unified patch with true line numbers. Each part is its own batch entry with the same path, labelled `part i of n` for the model.
3. **Bounded cost.** At most `review.maxFileParts` parts per file (new option, default 8, range 1–50). Parts beyond it are not sent; the file is reported incomplete as "`<path>`: parts 9–n of n not reviewed (`review.maxFileParts`)". The budget checks (`budget.maxInputTokens`, `budget.perReviewUsd`) count the parts actually planned: the whole-PR check counts the planned batch prompts in total, not the full patches.
4. **Findings.** Findings from different parts of one file are merged like findings from different batches; deduplication and the "Also at:" places (ADR-0039) work on path and line, so they need no change.
5. **Drizzle migration snapshots** (owner's pick «الفرق بس», 2026-10-24 ~08:55 Kuwait): an added `**/migrations/meta/NNNN_snapshot.json` is reviewed only where it differs from the previous snapshot: the highest `NNNN` below it across the head and merge-base listings of the same folder (the head's when the PR adds it itself). The rebuilt patch holds the changed regions of the new file with three lines of context, every line `+` (the whole file is new, so every line is commentable), with true new-file line numbers. Lines only in the previous snapshot are not shown; the SQL migration in the same PR carries drops and renames. With no previous snapshot (no folder, or none lower), the file follows rule 1. A snapshot identical to its predecessor is skipped as a file with no changes. When a folder listing throws (whether or not a previous snapshot exists, since it cannot be known), when a previous snapshot exists but a read fails, or when the diff is too costly, too large or empty, the snapshot's patch is dropped ("snapshot diff failed (…)") and the run is incomplete for it: the whole snapshot is never sent.

## Consequences

- Spec and design pull requests with large documents are reviewed in full, part by part; the design-review mode (ADR-0040) applies to each part.
- A rebuilt patch costs one or two extra contents reads per affected file; files that GitHub already patches are unaffected.
- A file split into many parts costs one call per part per bot. `review.maxFileParts` bounds it; at the default 8 parts of 24,000 tokens (`review.batchTokens`) a single file can add up to about 192,000 input tokens per bot.
- `PATCH_TRUNCATED_NOTE` and `truncatePatch` stay only for the truncation-recovery retry (ADR-0013), which halves an answer that ran out of output, not the input.
- Adds the `diff` (jsdiff, BSD-3-Clause) dependency to `packages/github`.
- Measured by the next comparison: PRs with large files should no longer end "incomplete" for this reason, and PayPos#482-style spec misses should fall.

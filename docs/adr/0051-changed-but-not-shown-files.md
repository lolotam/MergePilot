# ADR-0051: Changed files whose contents are not shown

**Date:** 2026-10-31 | **Status:** proposed | **Amends:** ADR-0031, ADR-0042

## Context

Lockfiles and generated or binary files are skipped before reviewing. Without their metadata, models repeatedly claimed a changed lockfile was not updated. Batched manifests alone did not protect single-pass or verification calls. Models also withheld defects in changed lines as out of scope or on speculative explanations.

## Options

- Show skipped contents, increasing cost and exposing unhelpful generated data.
- Share a small metadata-only disclosure across review and verification prompts.
- Rely on the batched manifest alone.

## Decision

Use a `CHANGED_BUT_NOT_SHOWN` UNTRUSTED block in single-pass, every batch (including recovery), and verifier calls whenever skipped files exist. Reuse manifest metadata and classification reasons: status, additions/deletions, path and reason. List at most 50 files, then count the remainder. Paths are redacted before rendering and shortening; sensitive paths remain omitted as in ADR-0031. Control characters and prompt delimiters are escaped. No contents are included. The existing batched `PR_MANIFEST` remains intact.

A shared short rule states these files ARE in this PR's change list, including removals: never claim they were omitted from the changes or not updated, and never infer their unseen contents. Findings about consequences of removal remain allowed, such as a shown caller importing a deleted module. Review preflight, batch pricing and verifier input checks measure the block in their existing token accounting. The cap is independent of the 300-file batch manifest.

The output contract allows withheld reasons only for an already reported/open claim, findings-limit overflow, a problem outside the PR changes, or an owner decision explicitly named in the rules. A defect in changed lines cannot be withheld as out of scope or on speculation. An uncertain claim belongs in findings at confidence 0.5-0.69, naming the code that would confirm it. This shared contract applies to both review languages.

## Consequences

Models can distinguish absent changes from skipped contents without reading lockfiles. Each call pays a bounded metadata cost; large metadata and the shared rule still participate in existing input limits rather than bypassing them. Token estimates use the actual rendered prompts, including the removal exception. Skip reasons use the existing classifier vocabulary (for example, lockfiles are `skip-generated`). A remaining limitation is that runtime-skipped batches are disclosed by existing incomplete reasons; this upfront list describes classification skips.

Persisting withheld items across runs, or promoting them on later commits, is deferred.

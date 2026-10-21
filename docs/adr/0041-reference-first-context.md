# ADR-0041: Reference-first repository context

**Date:** 2026-10-21 · **Status:** proposed · **Amends:** ADR-0029 (repository context)

## Context

The 48-hour comparison of 64 pull requests found that 31% of the findings the panel missed needed repository context outside the diff: a documentation pull request whose cited sources were never sent, a pull request whose constitution and ADR-0003 stayed out of the prompt, specification pull requests whose specs and ADRs were missing.

The gatherer of ADR-0029 looked for citations on the **added lines** of a patch only. So a file named in a hunk's context line, in the pull request description, or in the document a change touches was never sent, and a cited file that lost the priority fight against a sibling test or a local import was dropped.

## Decision

1. **Order.** The context of a review is planned in this order: the full version of a changed file, the **cited** files, the **referenced** files, the sibling test or implementation, the local imports, then the build and CI wiring. `ContextKind` gains `referenced`; `cited` and `referenced` outrank the test pair and the imports, which ADR-0029 had put first.
2. **Three sources.** The citations are scanned in this order, so the lookup limit goes to the strongest source: the added lines of every reviewed file, then the context lines around the change (the lines a hunk keeps, without their leading space), then the pull request description.
3. **Kinds and reasons.** A path named on an added line keeps the kind `cited` and the reason `cited by <file>`; a path named on a context line is `referenced`, `named near the change in <file>`; a code file a changed document names is `referenced`, `named in <file>`; a path named in the pull request description is `referenced`, `cited by the pull request description`.
4. **Spec ids.** `spec 012`, `Spec-012` and `specs/012-pay` resolve, through one listing of `docs/specs`, to `docs/specs/012-pay/spec.md`. The listing now returns the subdirectories with a trailing `/`, so a spec folder is visible in it.
5. **The pull request description is untrusted.** It is scanned for candidate paths only, up to 4,000 characters, and a URL is never fetched or followed: the path rules refuse it. Its text never reaches the prompt; only the files it names do, as untrusted repository context.
6. **No new knob.** The 20 distinct lookups per review, the allow, sensitive and exclude checks and the left-out disclosure (`<path> (cited lookup limit)`) are unchanged.
7. **Citations run before the test pairs**, so a tight read limit cannot starve them.
8. **The summary** names up to five of the files that came in by citation or reference, and counts the rest.

**Limit.** Only paths are resolved. An identifier a document names (a function, a class) is not resolved to a file: there is no cheap code search, as in ADR-0029 §1.d.

## Security

Unchanged from ADR-0029: every candidate path passes the same allow, sensitive and exclude checks before it is read, the head content is untrusted and redacted before it is sent, and nothing is executed. The pull request description reaches the gatherer as data only: it may name a candidate path, never a URL and never a command, and its own text never enters the prompt through this path. The prompt is unchanged.

## Consequences

- Test pairs and imports are the first to be dropped when the budget is tight: a cited or referenced file now outranks them.
- A documentation pull request costs more reads, within the same read cap (`review.contextReads`).
- The summary line names the cited files, so a reader sees why the review saw what it saw.

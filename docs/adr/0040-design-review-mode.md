# ADR-0040: Design and spec review mode

**Date:** 2026-10-21 · **Status:** accepted (owner's request relayed 2026-10-21) · **Amends:** ADR-0028 (review prompt v3) · **Related:** ADR-0030, ADR-0031, ADR-0034

## Context

A 48-hour comparison of 64 pull requests (2026-10-19 to 2026-10-21) measured the review panel against comparable Codex findings: the panel matched 27% of them, and it is weakest on pull requests whose diff is a specification or a design document.

On eyadex#89, a spec pull request, the panel missed 10 of the 11 Codex findings: composite foreign keys, missing indexes, overflow, and branch binding. On eyadex#90 it matched 0 of 4. On PayPos#438, #440 and #442 it missed keys, the serialization between two writers, the time zone, and the state-machine gaps.

The reason is the prompt itself: METHOD and CHECKLIST (ADR-0023, ADR-0028) are written for code. A document is read for prose — wording, structure, consistency — and not as the schema it will become, so a missing primary key or an ambiguous rounding rule is never a finding.

## Options

- **A. Detect a design call from its file paths and changed-line counts, and add a short checklist section only then.** The decision.
- **B. Always include the checklist.** It adds 195 words to every call of every code review, where it does not apply.
- **C. A repository config switch only.** The owners would have to know about it, and most spec pull requests come from repositories without a config file. Kept for later as an override.

## Decision

Option A.

1. `isDesignReview` in `packages/engine/src/review/design-review.ts` is a pure function of the call's files. It is active when the design-document paths — `docs/specs/**`, `docs/adr/**`, `docs/prd/**`, `**/spec.md`, `**/plan.md`, `**/prd.md`, `**/roadmap.md`, `**/*design*.md`, `**/*design*.mdx`, `**/spec*.md`, `**/*-spec*.md` — hold at least half of the changed lines (added plus removed).
2. It is decided per review call: a batched review (ADR-0031) decides on its own batch's files, and a follow-up review (ADR-0030) on the files it shows.
3. When it is active, `buildSystemPrompt` adds the DESIGN REVIEW section after REPORTING and before BATCHES. The section stays English in both languages, like the other sections (ADR-0023). Its checklist covers the keys of every table (primary keys, composite or business-qualified foreign keys, a unique key on every foreign-key target), the constraints and indexes on foreign-key and lookup columns, money (integer minor units, overflow of totals, rounding rules), time (the time zone of the business or branch, inclusive or exclusive bounds), concurrency (how concurrent writers are serialized, lock order, idempotent retries), state machines (every transition, terminal states, deferred constraints), the contradictions inside the document or with an ADR it cites, an API or projection field a later section relies on but no section defines, and an open question another section already treats as decided.
4. Severity: a design gap that will ship as a data-integrity or money bug is `high` when the quoted document text shows the gap, even before any code exists.
5. No configuration knob yet; a `.mergepilot.yml` override is left for later.

## Consequences

- The system prompt grows by 195 words (about 339 tokens by `estimateTokens`) on a design call only; a code review's prompt is unchanged.
- A small wording fix to an ADR also turns the mode on, so the extra tokens are spent on calls with little schema in them.
- A `high` finding is never dropped by the Jev filter (ADR-0023) and is kept below the consensus agreement (ADR-0017), so a single bot's design-mode `high` is published. The section therefore asks for `high` only when the quoted document text shows the gap. If the follow-up measurement shows design-mode false positives above the panel's 10% target, the rule moves to `medium` or to agreement-only.
- On a batched review the system prompt differs between design batches and code batches, so those two kinds no longer share a cacheable prefix (ADR-0031 §4). Batches of the same kind still do; since ADR-0031 groups docs apart from code, the cost is about one cache miss per kind.
- Measured by re-running the same 48-hour comparison after the release; the target is 30% or more of the Codex findings matched on spec and design pull requests.

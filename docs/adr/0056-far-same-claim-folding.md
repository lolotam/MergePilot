# ADR-0056: Folding same-claim findings beyond the line window

Status: accepted.

## Context

The reviewer panel compared findings only on the same path within three lines. Copies of the same
defect anchored farther apart or in different files stayed separate, even if one finding's
`Also at:` list pointed to the other. A partial review also left no incremental base, so a later
full review could be labelled as the first review.

## Decision

This amends the deterministic same-issue rule in [ADR-0017](0017-reviewer-panel.md), extends the use
of `Also at:` from [ADR-0039](0039-pattern-sweep-and-rules-check.md), and adds a kept-only tier to
[ADR-0050](0050-panel-verify-agreement.md).

A far pair consists of two kept findings from different bots, of the same location kind, on different
paths or more than three lines apart. Both claims must be mostly Latin script. Both suggestions must
exist and have a word-set Dice score of at least **0.20**. Titles of opposite polarity require a
suggestion score of at least **0.40**. Claim scores use the words in the title and body. Evidence
contributes location links. A location link in either direction must name the anchor's path within
three lines of the anchor.

| Tier | Minimum claim score | Minimum shared claim words | Additional condition |
|---|---:|---:|---|
| F1, listed place | 0.35 | 4 | `Also at:` links the findings |
| F2, same file | 0.45 | 8 | The paths match |
| F3, corroborated | 0.40 | 8 | An `Also at:` or evidence link, or matching paths with a suggestion score of at least 0.40 and four shared suggestion words |
| F4, strong wording | 0.50 | 8 | Any path |

One qualifying tier is sufficient. The merge joins nearby kept title matches, nearby kept wording
matches, then far pairs. Far pairs are ranked by descending claim score, with entry order breaking
ties. The nearby rejected-copy tiers and the optional nearby judge follow. Each cluster holds at
most one finding per bot. The most severe kept finding supplies the representative, with ties going
to the lowest bot slot. The existing earlier-comment duplicate check still applies.

The published inline comment adds up to ten sorted anchors from other kept findings to the existing
`Also at:` list, or creates a list. The same three-line window removes repeated places. Up to three
different titles appear by bot slot on a localized `Also raised as:` line below `Found by:`. The
representative object stays intact for per-bot accounting. Summary-only clusters use the same fold
rules and omit these two annotations from the summary.

When the publishing bot has partial markers and no complete base, the scope reads
`Full review (previous review was incomplete)`. An older complete marker can still serve as the
base. Using partial reviews as a base requires a separate marker and file-selection decision.

## Calibration and limits

The design used same-run pairs between different bots in published panel comments across 36 benchmark
pull requests. The benchmark labelled 180 pairs as duplicate.

| Set | PRs | Pairs | Labelled duplicates | Labelled duplicates the rule folds | Other pairs the rule folds |
|---|---:|---:|---:|---:|---:|
| Tuning | 12 | 1,246 | 74 | 53 | 0 of 1,172 |
| Validation | 12 | 3,202 | 74 | 39 | 3 of 3,128 |
| Confirmation | 12 | 1,347 | 32 | 15 | 4 of 1,315 |
| Total | 36 | 5,795 | 180 | 107 (59%) | 7 of 5,615 (0.12%) |

The design review found related root causes, symptoms, or implementations among the seven additional
folds. Two pairs included a distinct variant or location that loses its own comment. The location and
alternate title make those folds visible in the representative's comment.

- Thresholds were chosen on the tuning set. A validation false match with a suggestion score of zero
  prompted the 0.20 suggestion gate. Only the confirmation set was unseen by the final rule.
- Calibration scored published representatives. The merge scores raw per-bot findings, so production
  counts can differ.
- In tuning, the highest scores for distinct unlinked cross-file and same-file pairs were 0.448 and
  0.394, against thresholds of 0.50 and 0.45. Later sets included folded pairs without a duplicate
  label scoring up to 0.568.
- The word rule is calibrated for English and requires mostly Latin script. There is no calibration
  data for verifier rejections, which are excluded from far folds.
- The rule missed 73 labelled duplicate pairs because the claims shared too few words or the fixes
  differed. Before the suggestion gate, lowering the same-file threshold to 0.35 folded four distinct
  tuning pairs, and lowering the cross-file threshold to 0.40 folded two.

The public replay tests use synthetic findings to cover a four-bot distant fold, a linked cross-file
fold constrained by a shared bot slot, and an anchor already listed by the representative.

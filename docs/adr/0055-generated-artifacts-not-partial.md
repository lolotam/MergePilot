# ADR-0055 — Generated artifacts never mark a review partial

**Date** 2026-11-23 · **Status** accepted · **Amends** [ADR-0045](0045-split-large-files.md) rules 1 and 5 and [ADR-0051](0051-changed-but-not-shown-files.md)

## Context

An omitted GitHub patch makes a review partial when the patch cannot be rebuilt. Partial reviews cannot anchor an incremental review. Two observations from the motivating investigation explain why generated files triggered this flag even on otherwise healthy runs.

- Diffing two Drizzle snapshots of about 0.93 MB hit the 2-second timeout. Across one pair, key-order churn accounted for 2,236 added and 2,236 removed lines. Aligning the older snapshot to the newer snapshot's order reduced that pair to two changed ID lines and took 98 ms in the investigation's local replay.
- A 1,609,932-byte OpenAPI JSON file came back from the Contents API with `encoding: "none"`. The Action treated it as unavailable. The App read the response as empty text, which could also make successive oversized snapshots appear identical. Once the file was readable, the local replay built a patch of about 1,734 lines from four hunks.

## Decision

1. For a new Drizzle snapshot, align the previous snapshot's JSON object keys to the new snapshot's order when the new snapshot round-trips exactly. Preserve array order. Use the raw diff when alignment is unavailable. Snapshot hunks still contain only actual new-file lines with their original line numbers.
2. During patch rebuild, opt in to reading a blob by SHA when Contents omits its content and reports a size of at most 5 MiB. The Action and the App share the decoding rule. Rules, context, and exploration reads retain the existing Contents API limit.
3. Keep reviewing matching artifacts when a patch is available. A changed Drizzle snapshot or OpenAPI/Swagger JSON dump with no patch appears under `CHANGED_BUT_NOT_SHOWN` with reason `skip-generated`. The published summary lists up to ten redacted paths and the remaining count. OpenAPI and Swagger YAML files follow the ordinary missing-patch rule.
4. When an incremental comparison omits a generated artifact's patch, include the file metadata in the incremental review. An omitted compare patch for an ordinary changed text file still falls back to a full review.

## Consequences

| Case | Review outcome |
| --- | --- |
| New Drizzle snapshot with schema changes | Review the changed regions with real head line numbers. |
| New Drizzle snapshot with only changed IDs and reordered keys | Review the ID changes with their context. |
| Snapshot read or diff fails | Disclose the skipped snapshot. A healthy review remains complete. |
| Modified OpenAPI JSON exceeds 1 MB and fits the blob limit | Review the rebuilt diff when available. Disclose the artifact when the diff is unavailable. |
| Hand-written text file has no patch after rebuilding | Report the missing patch and mark the review partial. |
| Changed source file becomes binary and has no patch | The ordinary missing-patch rule still applies. |

The 2-second timeout, 20,000-edit limit, 50,000-line rebuilt patch limit, and `review.maxFileParts` still bound coverage. Rebuilt artifact patches are subject to the same review limits as other patches.

Owner ratified the amendment to ADR-0045 rule 5 on 2026-11-23.

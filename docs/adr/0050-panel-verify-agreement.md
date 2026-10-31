# ADR-0050: Panel verification agreement

**Date:** 2026-10-31 | **Status:** proposed | **Amends:** ADR-0017, ADR-0028

## Context

Each bot verifies independently before panel clustering. Discarding full rejected findings lost agreement: one copy could be published while another appeared under verification rejections. Independently raised defects rejected by every verifier also disappeared (Waleed-MCP-Hub#3 and eyadex#119).

## Options

- Keep per-bot verification as the final gate.
- Include flagged rejected copies in the existing consensus clustering and disclose revived claims.
- Run another panel verification pass, adding latency and cost without independent evidence.

## Decision

Use flagged rejected copies in consensus mode only. The engine returns transient, secret-redacted `verifyRejectedFindings` beside the existing compact `verifyRejected`; neither the REST contract nor `review_runs.result` gains that field. Single-bot and separate-mode behavior stays unchanged.

Clustering uses the same path, location kind, normalized title, nearby-line window, claim wording and optional budget-gated semantic judge. One bot cannot agree with itself. Rejected candidates share the existing 50-pair judge limit; pairs of kept findings are asked first, so rejected copies never displace them. If any kept copy exists, only kept copies compete for representative wording, and rejected copies add agreement. Incorporated copies no longer appear under verification rejections, including when agreement, cap or earlier-comment dedupe sets the cluster aside; those outcomes disclose the claim instead.

A rejected-only cluster needs at least two distinct bots before it becomes eligible. Its confidence is capped at `UNSHOWN_CODE_MAX_CONFIDENCE` (0.69). It follows the existing minimum agreement, critical/high exemption, findings cap and earlier-comment dedupe. Inline anchoring still requires a line in the PR diff. Revived inline claims are also listed in the summary under «Published although the verifier rejected them». Every revived comment and summary entry says, in the review language, that it is unverified, published despite verifier rejection, independently raised by N bots, and not checked by Jev. Revived findings skipped per-bot step e3; no extra Jev false-positive call runs.

The bots table still counts only per-bot accepted findings. Fate totals exclude rejected copies; an additional per-bot line explains incorporated rejections outside that count. Unmatched single-bot rejections remain in the rejection list.

## Consequences

Real repeated claims can survive a mistaken verifier, and kept claims have accurate agreement. Repeated false positives can also be revived: the claim that a form bypasses required React Hook Form was raised by all four bots and rejected five times on PayPos#705, with no owner reply. This rule publishes that class; its visible unverified marker lets benchmarking distinguish an actual owner rule from a repeated false positive. Revival is bounded by the ordinary cap, not an additional publication allowance. Provider protocols and fallback behavior do not change.

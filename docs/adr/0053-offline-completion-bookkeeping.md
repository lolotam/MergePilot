# ADR-0053: Unwired completion-addendum bookkeeping

- Date: 2026-11-03
- Status: Proposed. Local offline authoring/source review is authorized; publication,
  durable execution, provider calls and release of PosPay #785 HOLD are separately gated.
- Related: ADR-0001 (package boundaries), ADR-0033 (budget admission), ADR-0051
  (changed-but-not-shown files); [operational contract](../review-completion-offline.md).

## Context

A partial review receipt cannot be converted into historical full coverage by inference.
The separately proposed completion feature must preserve its parent and prove new coverage
of the exact frozen blob for each original bot, within approved resources and deadlines.
The current implementation is only a pure protocol foundation under packages/engine.
It has no provider, route, store, queue, publisher, Action export or runtime wiring.

## Local protocol decision

Bind a manifest to immutable parent receipt, head, config, exact Git blob identity and raw
SHA256/byte/line counts, plus all four original run/model/effort/skill/context identities.
Preserve original UTF8/CRLF bytes in bounded chunks; no delta substitution, clipping or
credit for historical unseen ranges. Each bot needs every exact chunk acknowledgment and
a separate subsequent whole-manifest synthesis acknowledgment. Completion concerns only
the addendum; the original receipt remains unchanged.

Coverage state validates each accepted acknowledgment, global event IDs, synthesis order,
revision and retained conflict fingerprints. Exact accepted/conflict replay is idempotent;
different conflicting payloads remain distinct observations and force partial status.
Accepted acknowledgments and conflict observations share the 8192-event bound.

Budget state defaults to zero calls/tokens/cost. Admission requires explicit approval and
resource ASSERTIONS; each new reservation equals asserted maxInput/maxOutput/maxCostMicros.
Unknown usage retains the full declared charge. New reservation and reserved replay have
different bookkeeping dispositions; nonreserved replay refuses. None authorizes dispatch.
Each actual retry would need separate future durable admission and a fresh dispatch claim.

Retain full semantic event assertions, including attempt identity, fence and never-dispatched
proof flag. Deduplicate IDs across all attempts. Restore must replay legal transitions from
reserved and match final status/counters; proof/history cannot be synthesized from a status.
Only a positively asserted never-dispatched transition releases token/cost charge, once;
lifetime attempt count remains. Unknown-to-settled does not silently refund the charge.

## Trust and compatibility limits

Pure reducers establish internal consistency, not authentication. An internally coherent
unsigned history can still be fabricated. Hashes/flags are not authenticated approval,
provider bounds, remote settlement or anti-tamper storage. Future authenticated persistence
must bind admitted attempts, original bot context and observations to the exact resource
profile, absolute deadline and claim fence. Incomplete/malformed old snapshots refuse;
missing proof is never upgraded into trusted history. No exactly-once guarantee is claimed.

The real frozen target remains parent 5744158903, head
fdc2345a32a5295623afb66cecbf9b70ac193c20, config 655cbe83c1cf, blob
442b5867e36e9d80170935cc371cf8cf44da1780. No actual FULL-BLOB coverage is credited by tests.
The original Codex resource bound and full durable/provider integration remain unapproved;
synthetic assertions do not satisfy them. No model switch, probe or spend follows this ADR.

MergePilot owns its future completion persistence/schema. PosPay owns its migration
reservation/order: immutable 0204 must precede later 0205 because its runner applies only
folderMillis above the watermark. This dependency does not expand Goal B's 18-row scope.

## Consequences and validation

These modules remain isolated and testable without external I/O or new dependencies.
Regression tests must reject inconsistent restored histories, undercharged reservations,
cross-attempt event collisions, duplicate coverage IDs and repeated-conflict revision drift.
Legal serialized histories still round-trip and existing complete fake coverage remains valid.
Production integration needs separate reviewed schema/authority/resource/publication plans;
PosPay #785 stays PARTIAL/HOLD and actual execution defaults remain 0 calls/$0.

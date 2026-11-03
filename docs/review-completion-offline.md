# Completion addendum: offline protocol only

Local pure manifest/coverage/budget modules. No route, provider invocation, persistence,
queue, publisher, Action export or runtime wiring. No supported public invocation exists.
Default budget is 0 calls/$0. Tests use synthetic bytes and fake trusted-boundary assertions.
Bookkeeping success is not authenticated model review, actual FULL-BLOB completion or GO.

The frozen intended target is parent 5744158903 / head fdc2345a32a5295623afb66cecbf9b70ac193c20,
config 655cbe83c1cf, blob 442b5867e36e9d80170935cc371cf8cf44da1780 (800994 bytes / 26391 lines).
Original four run, model, effort, skill and config identities must be recovered by the future trusted
boundary, never synthesized from current bots. The pure library binds explicit identities;
it cannot authenticate historical settings, remote observations or operator approval.

Manifest validates raw SHA256 and Git blob SHA1/length, preserves UTF8/CRLF bytes, partitions
at UTF8 boundaries with 64 KiB / 1024-newline bounds and explicit byte/line cursors. No clipping.
Source cap 1 MiB / 1024 chunks. Identity/profile/chunk hashes bind each acknowledgment. Each bot
needs every exact range and a separate subsequent whole-manifest synthesis acknowledgment.
Unknown/redacted/invalid material earns no coverage. Exact event replay is idempotent;
conflicting duplicates retain a partial result. No historical unseen range is credited.
The resulting status concerns this addendum scope; original partial receipt is never edited.

Budget snapshots retain immutable absolute deadline and lifetime per-bot attempts/token/cost
reservations. Admission needs explicit approval/resource ASSERTIONS from a future authenticated
boundary; valid fields/reference hashes alone prove neither approval nor endpoint enforcement.
Every transport retry reserves separately. Reservations must equal the asserted maxInput,
maxOutput and maxCostMicros ceilings; unknown usage retains those full declared charges. Late
settlement never silently refunds it. Positively never-dispatched work may release tokens/cost
once, retaining its lifetime reservation count. DB/queue restart must reuse the same durable
state and CAS; these reducers provide no durable cross-process claim or anti-tamper storage.
Recording a dispatch/late observation is not permission to call or resend to a provider.

Reservation success distinguishes `created` from `replayed` bookkeeping; replay after release,
dispatch, unknown or settlement refuses. Neither result authorizes a transport send. Event IDs
are compared across attempts using their semantic payload, including retained release proof.
Restore checks legal event chains, status and counters; missing historical proof is not invented.
Coverage restore checks event uniqueness, ordering and revision consistency; bounded conflict
fingerprints retain distinct observations while exact conflict replay does not advance revision.
Accepted acknowledgments plus conflict observations share the existing 8192-event ceiling.
An internally coherent unsigned snapshot is still not authenticated evidence. The future durable
boundary must authenticate provenance, derive real resource/cost assertions and claim each send.
Protocol decisions and the unapproved execution boundary: [ADR-0053](adr/0053-offline-completion-bookkeeping.md).

Execution remains blocked: original Codex subscription endpoint has no validated hard output
cap/input serialization bound; Claude high-effort thinking must be included in its wire cap;
generic outer/queue retries have no addendum durable admission callback. No model/provider
fallback or new pricing/spend permission. Separate measured resource and execution GO required.

MergePilot owns future completion persistence/schema. PosPay owns only its own migration
reservation/order, including immutable 0204 before later 0205: its runner selects folderMillis
above the applied watermark, so a later migration can strand 0204. This dependency does not
waive FULL-BLOB or expand MergePilot's 18-row recovery closure list. PosPay #785 remains HOLD.

# ADR-0052: Website security scan for the platform admin (`packages/webscan`)

- **Date:** 2026-10-31
- **Status:** Proposed. The original feature scope was approved by the owner on 2026-10-31 (docs/decisions.ar.md, batch 26, Q63). Subsequent review refinements in this PR are proposed implementation details, not additional quoted owner decisions. Nothing is implemented yet.
- **Related to:** ADR-0001 (package boundaries), ADR-0014 (retention), ADR-0021 (live run updates)

This ADR is the design spec for the feature. The [implementation plan](../superpowers/plans/2026-10-31-web-scan.md) maps it to four delivery PRs. All new scanner behavior described here remains proposed until implemented and verified.

## Context

MergePilot reviews pull-request diffs and never runs the code under review. The owner read a community guide for "Aegis", a local, single-user web vulnerability dashboard. Aegis sends bounded `GET`/`HEAD` requests to a live site and reports missing headers, exposed files, and SQL-error and reflection indicators. The owner wants the same capability inside MergePilot as a new section.

Three facts shaped the design:

1. **Scanning a live site is a different risk from reading a diff.** Requests leave our server for a third-party host. A checkbox is not proof of ownership. A user-supplied URL is an SSRF vector: DNS can point an allowed name at an internal address.
2. **The Aegis code has no license.** The guide calls it a gift but grants no rights, so we reuse ideas, not code. The ideas are the host allowlist, `GET`/`HEAD` only, the validation states and a transparent risk score. Every line in `packages/webscan` is written for MergePilot.
3. **MergePilot already has the parts:**
   - `isUserPlatformAdmin` and `requirePlatformAdmin`: a verified email in `MERGEPILOT_PLATFORM_ADMINS`; everyone else gets 404.
   - The SSRF guard in `apps/app/src/core/ssrf.ts` and `safe-fetch.ts`: the address is resolved, checked and pinned.
   - BullMQ queues and repeatable jobs (`retention-schedule.ts`).
   - Run redaction.
   - A GitHub App.

## Decision

### 1. Scope: the platform admin, on the admin's own sites

- Only a platform admin can see or use the section. Every web-scan API route sits behind `requirePlatformAdmin`, so anyone else gets the regular 404.
- Only hosts the admin adds to the site list are scanned. Matching is on the exact hostname. A subdomain is scanned only when it is listed itself. There is no wildcard and no "allow all" option.
- A manual scan needs a fresh confirmation each time: "I own this site or have explicit permission to test it". Enabling or changing a schedule requires the same confirmation and creates a new authorization audit record containing the administrator, timestamp, site and effective scope. Each scheduled scan references that record; disabling the schedule invalidates it for queued jobs. Both forms of authorization are recorded in the audit log (section 10).
- The authorizing user must still exist, have a verified email, and pass `isUserPlatformAdmin` against the worker's current deployed `MERGEPILOT_PLATFORM_ADMINS` configuration before a queued scan is claimed, before every request, and before each alert write. A revoked/deleted/unverified user invalidates that authorization. Configuration removal follows the application's existing deployment/restart semantics; a historical authorization record is not permanent privilege.
- Out of scope:
  - Workspace users.
  - PR preview URLs.
  - Ownership verification (DNS TXT or token file). That is needed only if the feature is ever opened beyond the platform admin, and it would need its own ADR.

### 2. Transport rules (fixed in code, no setting can turn them off)

- `GET` and `HEAD` only. No forms, no `POST`, no logins or cookies sent, no JavaScript execution. GET-only does not guarantee absence of side effects on the target: even an unauthenticated URL can embed an action or capability token. The administrator must choose a read-only crawl scope, and the confirmation must disclose this residual risk.
- **Before every request and every redirect hop:**
  1. The canonical hostname must equal this scan site's hostname, which must still be in the site list. A redirect to another listed site is rejected too. Only default HTTP/HTTPS ports (80/443) are allowed; a scan cannot switch to another service on the same hostname. URLs with credentials are rejected.
  2. The resolved address is checked by the existing SSRF guard (public addresses only) and pinned for the connection.
  3. Apply this request's authorized path/prefix, query-parameter rules, decoded action denylist and blocked paths to the destination, including redirects and fixed check targets. An HTTPS redirect to HTTP is rejected. A redirect cannot inherit authorization merely because its source URL was allowed.
  4. Redirects are followed manually (`redirect: 'manual'`), so every hop goes through steps 1–3.
- A destination denied by scope ends only that target's redirect chain: the denied destination is never requested, crawled or kept as a baseline, and the scan itself does not fail. The 3xx response received at the authorized path is real evidence and stays eligible for the checks that do not depend on the destination body: response headers and `Set-Cookie` attributes are evaluated on the redirect response itself, and `401`/`403`/`404`/`410` statuses at an exposed-file path are successful negative coverage for that file signature. A scope-denied 3xx is successful negative coverage for a file signature only when the redirect's location path differs from the probed path and does not end in the same file name or signature path (for example a login route) — a login-page redirect of a fixed `/.env` or `/server-status` check proves the file is not served there, so the occurrence can reach Fixed. A redirect that forwards to the file itself (such as `/.env` → `/static/.env`, or an HTTPS-to-HTTP downgrade pointing at the same file) proves nothing and leaves that occurrence Not checked until the administrator authorizes the redirect target for scanning. Statuses that confirm nothing (5xx and transport errors) and all destination-body checks (page body content, mixed content, stack traces) remain Not checked for that target. SSRF violations, revoked authorization, cancellation and lost locks remain fail-closed scan-level outcomes.
- One request at a time per scan, paced to the configured rate.
- Backoff: after three consecutive `429` or `503` replies, double the pacing interval. Honor a valid `Retry-After`, capped at 60 seconds and the remaining scan deadline. Three more consecutive replies stop the scan with the reason "stopped: the site is rate limiting". Every attempt and redirect counts toward the request cap; redirects have a fixed maximum of five hops.
- Every request sends `User-Agent: MergePilot-WebScan/1 (+<contact>)`. The contact is a global setting, so a site's WAF logs identify the scanner.
- The crawler follows same-host links only, inside administrator-specified exact-path or path-prefix rules (empty by default). The base page and the fixed paths of enabled checks are explicit scan targets, not permission to crawl every link. It skips:
  - decoded path segments and query parameter names containing `logout`, `signout`, `delete`, `remove`, `reset`, `unsubscribe` or `action` (case-insensitive); malformed encodings are rejected;
  - non-HTTP schemes;
  - the per-site blocked paths (section 5), even if an allow rule also matches;
  - parameterized links unless their exact path and parameter names have a separate per-site authorization. Active probes require an additional opt-in for those path/parameter pairs; that list is also empty by default. Arbitrary regexes, wildcard hosts and implicit query-value authorization are not supported.

  Links are canonicalized before queueing (WHATWG URL parsing, fragment removal and default-port normalization). Path matching preserves path-segment boundaries: `/docs` may authorize `/docs/a`, never `/docs-admin`. Raw query values live only in the bounded in-memory request plan; they never enter queue payloads, progress events, errors or stored evidence. The worker discovers and probes authorized query links within the scan process.
- **Implementation note:** the SSRF guard is HTTPS-only today (`parseSafeUrl` in `ssrf.ts` rejects other protocols). A scanner-specific transport-check entry point may send a query-free, fragment-free HTTP request on port 80 to the fixed path `/` only, unless that path is blocked, with the same address checks and pinning. It never copies an arbitrary base path (which may contain a secret) into cleartext. It inspects a redirect toward an authorized HTTPS destination, does not crawl over HTTP, and does not run parameterized/active/file probes there. All ordinary checks and crawling require HTTPS; provider calls stay HTTPS-only. Timeout, reset and unreachable outcomes of this optional probe are check-scoped Not checked and do not abort HTTPS scanning; global scan deadlines, hard request caps and security/authorization/cancellation/lock violations still stop or fail the scan. A refused/no-listener response is successful negative coverage specifically for `http-served-without-redirect` when the site's HTTPS endpoint was successfully reached in this scan; HTTP headers/redirect-policy issues requiring a response remain Not checked.

### 3. Checks

Each check can be switched on or off globally and per site.

| # | Check | Requests | Highest validation state |
|---|---|---|---|
| 1 | Security headers: HSTS, CSP, X-Frame-Options / `frame-ancestors`, X-Content-Type-Options, Referrer-Policy, Permissions-Policy | the crawled pages | Confirmed (directly observed) |
| 2 | Cookie attributes: `Secure`, `HttpOnly`, `SameSite` | the crawled pages | Confirmed |
| 3 | Transport: HTTP to HTTPS redirect, mixed `http:` content on HTTPS pages | 1 + the crawled pages | Confirmed |
| 4 | Disclosure: version in `Server` / `X-Powered-By`, stack traces in error pages | the crawled pages | Confirmed for headers, Likely for stack traces |
| 5 | Exposed files: `/.git/HEAD`, `/.env`, `/server-status`, `*.map` next to crawled scripts, `/admin/`, plus `robots.txt` and `security.txt` (informational), plus the per-site extra paths | one size-capped `GET` per exposed-file target, always sent for every enabled file check and counted against the request budget; its guarded reply is the only evidence that decides positive or negative coverage (for signature checks such as `ref:` in `.git/HEAD` the body is matched against the signature) | Confirmed when the signature matches, otherwise Likely |
| 6 | Active indicators on up to N separately authorized parameterized same-host links: a baseline `GET`, one `'` probe matched against known SQL error patterns, and one inert reflection marker that cannot execute; disabled until path/parameter opt-in exists | 3 per link | SQL error: Likely at most. Reflection: always Indicator |

Body content from exposed files is never stored. Only the status, the content type, the length, the matched signature name and an evidence hash are kept. There is no `HEAD`-only path for file checks: the size-capped `GET` in the table above is always sent, and only its guarded reply decides positive or negative coverage. Decisive negative statuses for file checks (`401`/`403`/`404`/`410`, or a scope-denied 3xx whose location differs from the probed path per section 2) are accepted only from that `GET`; skipping it leaves the occurrence Not checked, because routing may answer any preliminary probe differently from the method that fetches the body.

### 4. Findings model

- **Grouping:** occurrences have a versioned `occurrence_key` computed as HMAC-SHA-256 over an unambiguous canonical tuple of check id, issue id, stable check subject (for example cookie name), canonical host, normalized path and canonical query name/value pairs. Sort parameter names; preserve the order of repeated values within each name. This identity uses the **original baseline** URL, never the mutated probe/marker. Only the digest is persisted, not the raw tuple. A site-specific random identity key is encrypted at rest using a purpose-scoped vault envelope; the package receives an app-supplied fingerprint function, never the key or vault. The dashboard groups occurrences with the same check and issue per site and keeps up to 5 redacted evidence samples. Grouping is a view, not a change of identity.
- **`issue_key`:** check id + issue id + canonical host. It is the group identity for reports and alert aggregation, independent of crawl order. Exceptions, evidence hashes, coverage and remediation transitions use `occurrence_key`; this prevents an unchecked URL from disappearing behind a site-wide group.
- Catalogue issue ids have immutable evaluation meaning across implementation/check versions. `checkVersion` records provenance, not occurrence identity. Coverage explicitly lists the issue ids actually evaluated by that check version. A new version can prove an old occurrence fixed only if it evaluated the same immutable issue id on the same target; changed semantics require a new issue id. Retired issue ids are labelled archived/Not checked, never Fixed by a version change.
- **Validation state:** one of Confirmed, Likely, Indicator or Informational. Section 3 sets the ceiling for each check. A finding is never promoted beyond its evidence.
- **Severity:** Critical, High, Medium, Low or Info, fixed per issue in the check catalogue.
- **Risk score:** an internal 0–10 prioritization aid, labelled "not CVSS". The report lists its factors.

  `risk = min(10, severityBase × confidence × validation × surface)`

  | Factor | Values |
  |---|---|
  | severityBase | critical 10, high 8, medium 5, low 2.5, info 1 |
  | confidence | high 1, medium 0.8, low 0.6 |
  | validation | Confirmed 1, Likely 0.85, Indicator 0.6, Informational 0.4 |
  | surface | `1 + min(0.5, 0.1 × (affected URLs − 1))` |

- **Comparison:** each scan is compared with the site's last *completed* scan, supplemented by the retained latest occurrence/coverage state. Occurrences are New, Unchanged, Fixed or Not checked. Fixed requires a successful negative result for the same occurrence key and check, not merely absence from the new findings. A rediscovered authorized URL with the same keyed fingerprint proves query-target equivalence without storing its values; a changed value or check subject produces a different identity and cannot fix the old one. Disabled checks, unvisited URLs, errors and missing partial coverage produce Not checked. A stopped or failed scan never becomes a baseline and never marks anything Fixed. Unchecked historical occurrences remain in the state ledger for future scans; a partial baseline cannot erase them. A group is Fixed only when every outstanding occurrence is demonstrably fixed, and an archived member that was never proven fixed keeps its group blocked from the Fixed conclusion (section 11). An archived tombstone retains every safe finding field except its evidence body (section 11), so a completed scan that proves it Fixed emits the fixed transition from that retained metadata with `evidence: null` instead of a fabricated finding.
- **Redaction:** before any persistence, log, error, progress event or export, remove URL userinfo and fragments, replace **every** query value with a fixed placeholder, remove `Set-Cookie` values and authorization values, and pass evidence through the engine's `redactSecrets` (`packages/engine/src/security/redact.ts`). Do not store response bodies or arbitrary header values. Findings store safe structural facts, catalogue signature names and digests; dynamic path segments may contain secrets too, so paths shown in evidence must be limited to administrator-approved route patterns or redacted path placeholders. The transport never logs raw URLs or raw exception messages.

### 5. Settings: global defaults, per-site overrides, fixed ceilings

- **Global settings** (one row) hold the defaults. A site stores only the fields it overrides, and the dashboard shows whether each value is "global" or "set for this site".
- **Limits:**

  | Setting | Minimum | Default | Ceiling (code) |
  |---|---|---|---|
  | Requests per scan | 1 | 500 | 2000 |
  | Crawled pages | 1 | 100 | 300 |
  | Active-check links | 1 | 30 | 100 |
  | Requests per second | 1 | 2 | 5 |
  | Per-request timeout | 1 s | 10 s | 30 s |
  | Response size | 1 KiB | 1 MiB | 5 MiB |
  | Whole-scan time | 1 min | 20 min | 60 min |

  Counts, rates, byte sizes and durations in their stored units are finite positive integers. The API rejects values outside either bound. The worker rejects invalid/non-positive values and clamps positive values to the ceiling again before a scan starts. Disabling a check uses its switch, never a zero budget. Any value above its default needs a second confirmation tied to the submitted values before it is saved. Retention is an integer from 1 to 3650 days; exception expiry is either absent or a future timestamp.
- **Checks:** an on/off switch for each of the six checks.
- **Schedule:**
  - Frequency: daily, weekly, every two weeks or monthly.
  - Hour 0–23 and minute 0–59 in Kuwait time (`Asia/Kuwait`, UTC+3, no daylight saving). Daily has no day field; weekly uses weekday 0–6 (Sunday–Saturday); biweekly additionally stores an anchor local date and runs every 14 days from it. Monthly uses day 1–31, clamped to that month's last day.
  - Saving a schedule computes its first occurrence strictly after the save time. After downtime, enqueue at most one catch-up occurrence per site, then advance to the first future occurrence; do not replay every missed interval.
  - Default: weekly on Friday at 04:00 Kuwait time, switched off for new sites.
- **Alerts:**
  - Lowest severity (default High) and lowest validation state (default Likely, so indicators alone never open an issue).
  - Alerts on or off.
- **Paths:** per-site blocked crawl paths (for example `/checkout`), crawl path allow rules, parameterized-link authorizations, active-probe authorizations and extra exposed-file paths. Extra paths are same-host relative paths inside the authorized read-only scope; they cannot supply another origin or override blocked paths.
- **Contact** for the User-Agent, and **retention** (section 11).
- **Kill switch:** a global "pause all scans". It stops scheduling and manual enqueue. Each worker checks the live switch, site authorization and site enabled state before transitioning a queued scan to running and again before every outbound request. Jobs received while paused are stopped with zero requests; running scans abort before their next request. Failure to read the live state is fail-closed.

### 6. Data model (one migration, next free number)

| Table | Holds |
|---|---|
| `web_scan_settings` | the single row of global defaults, the kill switch, contact, retention and an audited approved-installation list of `(admin_user_id, installation_id, github_account_id)` bindings, empty by default |
| `web_scan_sites` | hostname (unique), query-free base URL, linked repository identity (owner/name, repository id, installation id and platform-admin owner), purpose-scoped encrypted identity key and envelope key version, bounded per-issue-group alert-episode state, JSON overrides, schedule and authorization reference, `next_run_at`, `last_scan_at`, soft-removal timestamp |
| `web_scans` | site, trigger (`manual` / `scheduled`), unique schedule/manual idempotency key, durable enqueue/outbox state, worker attempt id and heartbeat, status (`queued` / `running` / `completed` / `stopped` / `failed`), coverage summary, stop or fail reason, requests, pages, duration, effective settings, authorization audit id, timestamps |
| `web_scan_findings` | scan, `issue_key`, `occurrence_key`, `target_key`, check id/version and stable subject, severity, validation, confidence, risk factors, safe URL scopes, redacted evidence facts, evidence hash, comparison state |
| `web_scan_occurrences` | site and `occurrence_key` (unique), latest finding and coverage, outstanding/fixed/archived state (archived rows are identity tombstones: occurrence/target identity, check/issue ids, stable subject, every safe finding field except the evidence body — severity, validation, confidence and safe location — the exception-pinned evidence hash and comparison metadata, never evidence bodies), last observed timestamp and archive reason, evidence hash and notification-episode reference; retained independently from scan snapshots within the retention policy |
| `web_scan_exceptions` | site, `occurrence_key`, evidence hash, kind (`accepted` / `false_positive`), bounded `reason_category`, free-form reason, `expires_at` (nullable means no expiry), created by and at |
| `web_scan_alerts` | site, validated repository/installation ids, GitHub issue number, occurrence/episode membership, idempotency marker, pending/sent/unknown delivery state and last observed open/closed/unknown issue state |
| `web_scan_audit` | actor, action, target, before and after JSON (no secrets), timestamp |

The store exposes no update or delete for `web_scan_audit`. Site removal is a soft removal: cancel queued scans and invalidate authorization, but preserve audit references, the identity key and occurrence history. Adding a previously removed hostname restores its original row/id transactionally after fresh authorization by its current platform-admin owner. Preserve identity/history/exceptions; reset schedules, alerts, repository binding and overrides to current safe defaults, require fresh scope, and never revive old queued work. Ownership transfer requires an explicit audited admin action, not an implicit restore by another user. Database mutations and their audit inserts share one transaction; a failed audit insert rolls back the mutation.

The current provider vault API is provider-typed. Implement a separate purpose-scoped sealing API using the same envelope primitives, with AAD binding both `webscan-identity` and site id; never cast a scanner secret to a provider credential. Master-key rotation rewraps all scanner identity keys before an old master key may be retired, without changing HMAC identities. These keys never appear in API, audit or ordinary workspace credential exports. Tests cover cross-site/purpose rejection, rotation, key-version persistence and absence from output.

### 7. Execution

- A dedicated BullMQ queue `web-scan` with queue-wide global concurrency 1 as well as local worker concurrency 1. Before scanning, acquire a database advisory lock held on a dedicated connection for the scan lifetime, shared by every web-scan worker. Release it in `finally`; connection loss aborts the scan and prevents further requests. A worker losing its BullMQ lock also aborts. These guards cover stalled-job recovery and rolling deployments, not just one process. Reviews use their existing independent queue and never wait behind a scan.
- A manual scan is enqueued from the dashboard. Progress (activity, requests, pages, elapsed time) streams to the page the same way as live run updates (ADR-0021).
- A repeatable "web-scan-tick" job every 15 minutes locks each due site row. In one database transaction, insert one queued scan/outbox record under a unique `(site_id, scheduled_for)` key, advance `next_run_at` and append audit. A dispatcher retries unpublished outbox records using the persistent scan id as BullMQ job id. Queue delivery is at-least-once; the worker atomically claims a still-queued scan and never executes a terminal scan again. A crash between Redis enqueue and the database acknowledgement cannot create a second scan or repeat a completed occurrence. Manual requests use an administrator-generated idempotency key with the same outbox path. The tick does nothing while the kill switch is on.
- A claimed run stores its worker attempt id and heartbeat. On startup and each tick, reconciliation may acquire the same global advisory lock and, only after the heartbeat is stale and no BullMQ lock remains, mark an orphaned running attempt failed (`worker_lost`) with audit. It never replays that attempt's active requests or promotes it to a baseline. Terminal writes are fenced by attempt id; an old worker cannot overwrite reconciliation. If lock/queue state cannot be established, leave it visibly pending operator recovery and fail closed instead of guessing.
- `packages/webscan` exports a pure `runScan(input, deps)`:
  - `input` holds the site, the effective settings and the checks.
  - `deps` holds a guarded fetch, a clock, cancellable sleep, an `AbortSignal`, a progress callback and app-supplied identity functions.

  The package never imports from `apps/` or `packages/engine`. The app injects the SSRF-guarded fetch, and the package also re-checks the host list itself as a second guard.
  `runScan` returns the current observation only. The app loads retained occurrence state and passes both to the separate pure `compareScan(current, retained)` export before committing occurrence transitions. The implementation plan defines the exact coverage/comparison interfaces.
- Reaching the configured page or active-link cap completes the bounded scan with `partialCoverage: true`; the coverage ledger determines what can be marked Fixed. Optional HTTP-probe and rejected-scope outcomes follow section 2 rather than becoming whole-scan errors. Global request/time ceilings, rate limiting, cancellation, kill switch, authorization revocation and lease loss stop the scan. Other unexpected target/transport errors fail it. These reasons are fixed catalogue codes with localized display text, never raw URLs or target response text; `runScan` returns the typed reason and final request/page/duration counters. A request/time-stopped run can show observed findings but deliberately cannot supply a completed baseline; operators must narrow scope to fit the bounded budget.

### 8. Alerts (GitHub issues)

- After each **completed scheduled** scan, the worker collects outstanding occurrences that:
  - pass the site's alert thresholds;
  - have no active exception;
  - belong to a per-`issue_key` alert episode whose bounded state has no successfully delivered open issue for the currently validated repository — that is, the episode has not delivered yet, its earlier issue was observed closed and the recurrence rule below permits another issue, or its earlier issue was confirmed missing (deleted) and is being replaced inside the same episode.

  Alert state is separate from New/Unchanged comparison and lives in bounded episodes grouped by `issue_key`. An episode is started by first eligibility of its group, re-eligibility after all members were excepted, recurrence after all members were demonstrably Fixed, or a new semantic issue id or higher eligible severity/validation; sample/URL/nonce churn alone cannot. Delivery consumes an episode's unnotified state only through a confirmed issue. Because eligibility reads episode state rather than stored per-occurrence generations, an additional query-value variant or cookie subject in an already unresolved eligible group attaches to that group's existing episode and cannot create one issue per scan. A new semantic issue id or higher eligible severity/validation can start a new episode, but value churn never can. Manual scans update state but never consume an unnotified episode. Keep this bounded per-`issue_key` episode state on the site row under its transaction lock, independently from occurrence retention.
- Alerts require a **private** repository accessible to the same currently authorized platform administrator through an exact approved-installation binding in `web_scan_settings`. Approval is an explicit audited admin configuration action; the server verifies the installation's GitHub account id and the administrator's authenticated GitHub installation access before saving it. Missing identity/access proof keeps alerts disabled. Workspace membership or a repository name alone is not approval. Bind immutable repository and installation ids when the site is saved and re-check the binding, current administrator membership, current authenticated GitHub installation/repository access, private visibility, account id and issue permissions before each write; loss of access or inability to verify it disables delivery and records the reason.
- At most one issue per scheduled scan contains aggregate counts by severity and a platform-admin dashboard link, without site hostname, affected URLs or evidence. Each issue has a deterministic delivery marker. Reserve a delivery record transactionally before writing, and reconcile by marker before retrying an ambiguous write; do not blindly repeat issue creation after a timeout. An unresolved delivery stays Unknown and needs operator attention if reconciliation cannot establish whether it succeeded.
- Fetch the current state of every referenced issue before eligibility and deduplication. An observed closed issue records the delivery as closed without endless reopening; reopening is observed on the next evaluation. Closing an issue while the finding remains unchanged does not by itself remove the episode: the group stays unresolved until its members are all demonstrably Fixed or excepted, and only then may recurrence open a new issue. A new semantic episode may notify again even if an older issue remains open.
- An issue fetch that cannot establish the issue's state — `403` access loss, `404`/`410`, a transfer, or an unresolved delivery timeout — records the issue state as `unknown`, never as closed and never by assumption open. `unknown` never advances an episode's last-notified reference, never proves anything Fixed, and never suppresses a later alert by itself. A `404`/`410` obtained through the deterministic marker-based reconciliation path confirms the referenced issue is missing; a confirmed-missing issue keeps its episode eligible so the next eligible scheduled scan may open exactly one replacement issue with the same deterministic marker, which is then fetched normally and cannot repeat per scan. An unresolved `403`/transfer/unknown state leaves the episode visibly Unknown for operator attention instead of producing an issue every scan.
- A later completed scan with coverage proving all referenced occurrences Fixed adds one idempotent "fixed" comment. A "fixed" comment is reserved for that outcome and never posted for an administrator resolution: an Accepted or False-positive decision is an accepted risk, not negative coverage, and telling the issue thread that an accepted vulnerability was remediated would be wrong. Occurrences archived while never proven fixed keep the group blocked until one of two section 11 end states — re-proved coverage at the exact occurrence key, or an explicit audited administrator resolution against the archived identity. There is no third automatic path: raw query values are never persisted (section 4), so a completed scan cannot reconstruct or evaluate a churned archived member's target; an archived member whose exact key is never re-observed stays blocking its group until it is resolved by exception. An administrator resolution unblocks the group as a separate "resolved by exception" outcome: the worker posts one idempotent comment on the referenced episode issue naming the exception kind, its bounded reason category and the expiry (or its absence) — using the same aggregate format as the issue body, without evidence, URLs or the administrator's free-form reason — and never posts a "fixed" comment for it. Missing coverage never triggers either comment. The worker never closes issues or changes their existing bodies. Alert delivery records and audit capture both the attempt and its confirmed outcome without claiming a database/GitHub distributed transaction.
- The App needs the `Issues: write` permission; the owner adds it. A missing installation or permission is recorded on the scan and in the audit log and shown on the site page. It is not retried in a loop.

### 9. Exceptions

- The admin can mark a finding Accepted or False positive, with a reason category, a reason and an expiry (default 90 days, or none). The reason category is a bounded, validated value taken from `not_applicable`, `already_mitigated`, `accepted_risk`, `out_of_scope`, `third_party_dependency` and `test_environment`, and it is stored and validated with the exception. The free-form reason stays in the dashboard and the audit log and is never published to GitHub, because it can carry URLs or evidence that must not leave the platform.
- An exception applies only while both the `occurrence_key` and the evidence hash match. Evidence fingerprints are versioned SHA-256 digests of a check-specific canonical tuple: header issue/name and normalized directives with CSP nonces omitted; cookie name and attribute booleans (never its value); transport issue and safe scope; disclosure signature id; exposed-file signature id plus a body digest computed only in memory; active-indicator signature/parameter names (never marker text or query values). Raw bodies, timestamps, request ids, URL ordering and sample order are not hash inputs. Hashing happens after structural sanitization; exposed bytes are digested before immediate disposal and only the digest enters the tuple. Each occurrence has its own hash, so another affected URL cannot invalidate its exception. A changed exposed-file digest or changed canonical evidence makes the occurrence return. The section 11 administrator resolution against an archived identity uses the same exception record, pinning the evidence hash captured in the archival tombstone, so it still matches only the identical finding if it returns.
- Revoking an exception returns the finding to its normal outstanding state. When the exception was recorded against an archived tombstone, revoking it restores that tombstone to its unresolved outstanding state under the same identity (section 11) instead of leaving the occurrence absent from risk and alert state until it is rediscovered.
- An excepted finding still appears in the report, labelled, but never raises an alert.

### 10. Audit log

Append-only, shown in its own tab. It records:
- every settings change, with old and new values;
- site additions and removals;
- every scan start, with who confirmed authorization and when;
- stops, exceptions and alerts.

Retention never deletes it. Every database state transition and its audit insertion are atomic. External queue/GitHub actions use durable intent and outcome records, so an audit can distinguish requested, delivered, failed and unknown. Scheduled starts reference the authorization audit entry that enabled their current scope.

### 11. Retention

- Scans and their findings older than the configured number of days (default 365) are deleted by the existing nightly retention job.
- The last completed scan of each site is always kept as the comparison baseline. Current occurrences/coverage survive snapshot deletion.
- An occurrence never proven fixed becomes a candidate for archival as historical Not checked (`unobserved_retention`) only when **all** of these hold: the retention horizon has elapsed since its last observation — the horizon is the configured retention period, or the site's schedule interval plus 24 hours, whichever is longer — **and** no completed scan of that site has since evaluated that occurrence's exact target and issue id with a `checked` coverage outcome (a scan that evaluated them would already have re-observed the occurrence or proven it Fixed). Paused and stopped runs, failures and kill-switch windows are not opportunities of either kind, so a real outstanding finding can never be archived away merely because time passed.
- Archival removes the occurrence from active risk calculations, not from remediation blocking: an archived occurrence that was never proven fixed keeps its alert group in a non-Fixed "unresolved: unverified member archived" state and the group's Fixed comment stays deferred. The row is kept as an archival tombstone — occurrence and target identity, every safe finding field except the evidence body (severity, validation, confidence and safe location) and comparison metadata, never evidence bodies — and is never pruned while unproven. Keeping those safe fields is what lets the tombstone be restored or proven Fixed later without fabricating values. The blocker ends only one of two ways: the current run returns a finding at the exact occurrence key, re-activating the row as outstanding (direct positive evidence, permitted for any terminal run — a stopped run is not a baseline but may still re-activate); or a **completed** scan proves the row Fixed through successful negative coverage at the exact key. No automatic group conclusion exists beyond those per-occurrence proofs: because raw query values are never persisted (section 4), a completed scan cannot reconstruct or evaluate a churned archived member's target, and absence from a new report proves nothing for a member that was never re-observed. An explicit audited administrator resolution (an Accepted/false-positive exception recorded against the archived identity, where live evidence hashing cannot apply) is the operator path of last resort; it unblocks the group as "resolved by exception" under the rules of section 8, never as Fixed. Ageing or catalogue retirement never means Fixed on its own and never posts a Fixed comment by itself.
- Retention prunes expired snapshots and evidence payloads. Archival tombstones are pruned only when a completed scan proves them Fixed. An administrator resolution never authorizes pruning on its own, not even when it carries no expiry: the exception API can revoke it, and pruning the tombstone first would destroy the occurrence, target and group metadata needed to restore the blocker when the exception is revoked. A tombstone behind an administrator resolution is therefore retained for as long as that exception exists, whether or not the resolution has an expiry. When such an exception expires **or is revoked**, the store restores that row to its unresolved outstanding state under the same identity — including the exception-pinned evidence hash — with the pruned evidence represented explicitly (the package boundary emits `evidence: null` for it) and every other safe finding field taken from the retained metadata, so the finding re-enters risk and alert state instead of silently disappearing and no value is fabricated. This lets `compareScan` always match a surviving identity. Pruning an old target must not reopen the same unresolved group episode.
- Persist an audit summary and preserve active exceptions, authorization references, alert delivery/unknown outcomes and bounded group episode state. Do not normalize volatile values or cookie subjects into another target's identity merely to reduce history.

### 12. Dashboard (platform admin area, Arabic and English)

- **Global settings:** limits with the confirmation, check switches, default schedule, alert thresholds, contact, retention and the kill switch.
- **Sites:** list, add or remove, linked repository, overrides with their source, schedule, blocked and extra paths.
- **Scan:** start with the confirmation, live progress, stop, grouped findings with validation, risk and factors, the comparison, and HTML/JSON export.
  - The export has two layers: an executive summary, then technical findings with methodology and limitations.
  - All content is escaped in HTML exports.
- **Exceptions** and **Audit log** tabs. An exception records a bounded reason category, a free-form reason (dashboard and audit only, never published to GitHub) and an expiry, and revoking it restores the finding it covered.

All user-visible text lives in the dashboard i18n dictionaries.

## Testing

No test contacts an external website. Use injected request/DNS boundaries or local ephemeral servers only. Real `demo.testfire.net` or other target-site requests are prohibited in tests.

- **Guarded client** (local ephemeral servers):
  - hosts outside the list, unlisted subdomains, lookalikes (`site.com.evil.io`);
  - off-list redirects and redirect limits;
  - DNS answers that resolve to private addresses;
  - timeouts, oversized bodies, the request cap and pacing;
  - `429` backoff and stop.
- **Checks:** fixed HTML and header fixtures for every check, including encoded, partial, attribute and duplicate reflections. A reflection never rises above Indicator.
- **Scope and safety:** decoded action paths/query names, denied query links without explicit authorization, path-prefix boundaries, redirects to another separately listed site, non-default ports, and query/path secret sentinels absent from persistence/events/exports. These fixtures demonstrate the guards; they cannot prove arbitrary GETs have no side effects.
- **Identity and revocation:** distinct cookie subjects and query variants, stable keyed identity for the same rediscovered baseline, correct negative coverage, sealed site keys surviving master-key rotation, wrong-site/purpose rejection, and revoked/unverified/deleted authorizing users. Check same-host redirects outside scope and HTTP queries/downgrades are denied, and a closed HTTP port does not abort HTTPS checks.
- **Settings:**
  - ceilings rejected by the API and clamped by the worker;
  - the high-value confirmation;
  - global and per-site precedence.
- **Exceptions:** expiry — including an exception over an archived tombstone expiring and restoring the row to unresolved with pruned evidence — revocation of an exception with no expiry, which restores the archived blocker it had resolved instead of losing the occurrence identity — and the finding returning when the evidence hash changes.
- **Comparison:** New, Unchanged, Fixed and Not checked; disabled checks, changed settings, unvisited URLs, transient errors and partial scans never invent remediation. Occurrences survive repeated partial baselines and snapshot retention.
- **Authorization:** a non-admin gets 404 on every route.
- **Redaction:** no token or cookie value is stored in evidence.
- **Worker:** two replicas, stalled-job recovery, database/BullMQ lock loss, zero-request paused/revoked jobs, crash boundaries across schedule/outbox/Redis, and atomic audit rollback. Kuwait schedules cover biweekly anchors, days 29–31, leap years and one catch-up after downtime.
- **Recovery:** restoring a tombstoned hostname preserves its original identity/history without reviving jobs; orphaned running attempts fail under reconciliation with attempt-id fencing and no replay of active requests.
- **Alerts:** manual-first baselines, exception expiry, changed evidence, fixed-then-recurring issues, closed/reopened issues, issue resolved by an administrator exception (distinct comment carrying the kind, reason category and expiry, never the free-form reason, never a Fixed comment), visibility/account changes, missing permissions and ambiguous GitHub writes with marker reconciliation. No target details enter issue bodies.

## Rollout

Four pull requests, started after #188 and #189 are merged. The migration, ADR and decisions-log numbers are rebased then.

1. **`packages/webscan`:** guarded-client contract, crawler, checks, grouping, risk, comparison and report rendering.
2. **App storage and worker:** migration, store methods, queue, tick job, settings validation and ceilings, audit, retention.
3. **API and dashboard:** platform admin routes and the web pages, in Arabic and English.
4. **GitHub issue alerts:** needs the owner to add `Issues: write` to the App.

Everything ships switched off: no sites and no schedules. The owner runs the first real calibration manually with the same fresh ownership/permission confirmation as every manual scan. `demo.testfire.net` is only a candidate when the owner has explicit permission; otherwise use an owned site or local fixture, then calibrate on an authorized owned site.

## Consequences

- The active checks (section 3, check 6) reach production databases and can trigger WAF alerts or a temporary block of the server's IP. Pacing, backoff and the User-Agent contact reduce this but do not remove it. A block affects only the worker's outbound IP, and the reviews' model calls go to providers, not to the scanned sites.
- The feature adds outbound traffic from the worker host. If a block or the load ever matters, `packages/webscan` can move to its own container without changing its interface.
- Out of scope:
  - authenticated scanning, forms and state-changing requests;
  - JavaScript rendering;
  - CVSS;
  - scanning for anyone but the platform admin.

## Alternatives considered

- **Inside `packages/engine`:** rejected. It mixes diff review with live scanning and works against ADR-0001's boundaries.
- **A separate service from day one:** deferred. It is safer for IP blocks but adds a Dokploy app the owner must configure.
- **Copying the Aegis source:** rejected. It has no license.

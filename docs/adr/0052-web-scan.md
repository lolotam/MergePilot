# ADR-0052: Website security scan for the platform admin (`packages/webscan`)

- **Date:** 2026-10-31
- **Status:** Proposed. Design approved by the owner on 2026-10-31 (docs/decisions.ar.md, batch 26, Q63). Nothing is implemented yet.
- **Related to:** ADR-0001 (package boundaries), ADR-0014 (retention), ADR-0021 (live run updates)

This ADR is the design spec for the feature. Implementation plans refer to it.

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
- A manual scan needs a fresh confirmation each time: "I own this site or have explicit permission to test it". A scheduled scan runs only for a site whose schedule the admin switched on. Both are recorded in the audit log (section 10).
- Out of scope:
  - Workspace users.
  - PR preview URLs.
  - Ownership verification (DNS TXT or token file). That is needed only if the feature is ever opened beyond the platform admin, and it would need its own ADR.

### 2. Transport rules (fixed in code, no setting can turn them off)

- `GET` and `HEAD` only. No forms, no `POST`, no logins or cookies sent, no JavaScript execution.
- **Before every request and every redirect hop:**
  1. The host is checked against the site list.
  2. The resolved address is checked by the existing SSRF guard (public addresses only) and pinned for the connection.
  3. Redirects are followed manually (`redirect: 'manual'`), so every hop goes through steps 1 and 2.
- One request at a time per scan, paced to the configured rate.
- Backoff: three `429` or `503` replies in a row slow the scan down. If the site keeps answering that way, the scan stops with the reason "stopped: the site is rate limiting".
- Every request sends `User-Agent: MergePilot-WebScan/1 (+<contact>)`. The contact is a global setting, so a site's WAF logs identify the scanner.
- The crawler follows same-host links only. It skips:
  - paths whose segments contain `logout`, `signout`, `delete`, `remove`, `reset`, `unsubscribe` or `action`;
  - non-HTTP schemes;
  - the per-site blocked paths (section 5).

  Links are canonicalized before queueing.
- **Implementation note:** the SSRF guard is HTTPS-only today (`parseSafeUrl` in `ssrf.ts` rejects other protocols). The HTTP-to-HTTPS redirect check needs plain HTTP on listed hosts, so the guarded fetch gains an `http:` path with the same address checks and pinning. Only the web-scan caller may use plain HTTP; provider calls stay HTTPS-only.

### 3. Checks

Each check can be switched on or off globally and per site.

| # | Check | Requests | Highest validation state |
|---|---|---|---|
| 1 | Security headers: HSTS, CSP, X-Frame-Options / `frame-ancestors`, X-Content-Type-Options, Referrer-Policy, Permissions-Policy | the crawled pages | Confirmed (directly observed) |
| 2 | Cookie attributes: `Secure`, `HttpOnly`, `SameSite` | the crawled pages | Confirmed |
| 3 | Transport: HTTP to HTTPS redirect, mixed `http:` content on HTTPS pages | 1 + the crawled pages | Confirmed |
| 4 | Disclosure: version in `Server` / `X-Powered-By`, stack traces in error pages | the crawled pages | Confirmed for headers, Likely for stack traces |
| 5 | Exposed files: `/.git/HEAD`, `/.env`, `/server-status`, `*.map` next to crawled scripts, `/admin/`, plus `robots.txt` and `security.txt` (informational), plus the per-site extra paths | `HEAD`, then a size-capped `GET` only to match a signature (for example `ref:` in `.git/HEAD`) | Confirmed when the signature matches, otherwise Likely |
| 6 | Active indicators on up to N parameterized same-host links: a baseline `GET`, one `'` probe matched against known SQL error patterns, and one inert reflection marker that cannot execute | 3 per link | SQL error: Likely at most. Reflection: always Indicator |

Body content from exposed files is never stored. Only the status, the content type, the length, the matched signature name and an evidence hash are kept.

### 4. Findings model

- **Grouping:** findings with the same check and issue are grouped per site. All unique affected URLs and up to 5 evidence samples are kept.
- **`issue_key`:** a stable key made of the check id, the issue id, the host and the normalized path or "site-wide". It drives scan-to-scan comparison, exceptions and alerts.
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

- **Comparison:** each scan is compared with the site's last *completed* scan. Every finding is New, Unchanged or Fixed. A stopped or failed scan never becomes a baseline and never marks anything Fixed.
- **Redaction:** the app passes evidence through the engine's `redactSecrets` (`packages/engine/src/security/redact.ts`) before storing it. On top of that, `Set-Cookie` values, `Authorization`-like strings and query values that look like secrets are removed.

### 5. Settings: global defaults, per-site overrides, fixed ceilings

- **Global settings** (one row) hold the defaults. A site stores only the fields it overrides, and the dashboard shows whether each value is "global" or "set for this site".
- **Limits:**

  | Setting | Default | Ceiling (code) |
  |---|---|---|
  | Requests per scan | 500 | 2000 |
  | Crawled pages | 100 | 300 |
  | Active-check links | 30 | 100 |
  | Requests per second | 2 | 5 |
  | Per-request timeout | 10 s | 30 s |
  | Response size | 1 MB | 5 MB |
  | Whole-scan time | 20 min | 60 min |

  Any value above its default needs a second confirmation in the dashboard before it is saved. The API rejects any value above its ceiling with the reason, and the worker clamps again before a scan starts.
- **Checks:** an on/off switch for each of the six checks.
- **Schedule:**
  - Frequency: daily, weekly, every two weeks or monthly.
  - Day and hour in Kuwait time (UTC+3, no daylight saving).
  - Default: weekly on Friday at 04:00 Kuwait time, switched off for new sites.
- **Alerts:**
  - Lowest severity (default High) and lowest validation state (default Likely, so indicators alone never open an issue).
  - Alerts on or off.
- **Paths:** per-site blocked crawl paths (for example `/checkout`) and extra exposed-file paths.
- **Contact** for the User-Agent, and **retention** (section 11).
- **Kill switch:** a global "pause all scans". It stops the scheduler and aborts a running scan at its next request.

### 6. Data model (one migration, next free number)

| Table | Holds |
|---|---|
| `web_scan_settings` | the single row of global defaults, the kill switch, the contact and the retention |
| `web_scan_sites` | hostname (unique), base URL, linked repository (`owner/name`, nullable), JSON overrides, schedule fields, `next_run_at`, `last_scan_at` |
| `web_scans` | site, trigger (`manual` / `scheduled`), status (`queued` / `running` / `completed` / `stopped` / `failed`), stop or fail reason, requests, pages, duration, the effective settings used, who confirmed, timestamps |
| `web_scan_findings` | scan, `issue_key`, check, severity, validation, confidence, risk and its factors, affected URLs, redacted evidence samples, evidence hash, comparison state |
| `web_scan_exceptions` | site, `issue_key`, evidence hash, kind (`accepted` / `false_positive`), reason, `expires_at` (nullable means no expiry), created by and at |
| `web_scan_alerts` | site, repository, GitHub issue number, the `issue_key`s it lists, open or closed |
| `web_scan_audit` | actor, action, target, before and after JSON (no secrets), timestamp |

The store exposes no update or delete for `web_scan_audit`.

### 7. Execution

- A dedicated BullMQ queue `web-scan` with worker concurrency 1: one scan at a time platform-wide and never two for the same site. Reviews never wait behind a scan.
- A manual scan is enqueued from the dashboard. Progress (activity, requests, pages, elapsed time) streams to the page the same way as live run updates (ADR-0021).
- A repeatable "web-scan-tick" job every 15 minutes enqueues the sites whose `next_run_at` has passed, one after another, then advances each `next_run_at`. It does nothing while the kill switch is on.
- `packages/webscan` exports a pure `runScan(input, deps)`:
  - `input` holds the site, the effective settings and the checks.
  - `deps` holds a guarded fetch, a clock, an `AbortSignal` and a progress callback.

  The package never imports from `apps/` or `packages/engine`. The app injects the SSRF-guarded fetch, and the package also re-checks the host list itself as a second guard.
- Stop reasons are recorded verbatim: limit reached, time limit, rate limiting, cancelled by admin, kill switch, target error.

### 8. Alerts (GitHub issues)

- After each **scheduled** scan, the worker collects the New findings that:
  - pass the site's alert thresholds;
  - have no active exception;
  - are not already listed in an open alert issue.

  Manual scans show their results only in the dashboard.
- One issue per scan lists those findings in the site's linked repository, through the GitHub App installation. When a later completed scan marks a listed finding Fixed, the worker adds a "fixed" comment to that issue. The worker never closes or edits issues beyond that.
- The App needs the `Issues: write` permission; the owner adds it. A missing installation or permission is recorded on the scan and in the audit log and shown on the site page. It is not retried in a loop.

### 9. Exceptions

- The admin can mark a finding Accepted or False positive, with a reason and an expiry (default 90 days, or none).
- An exception applies only while both the `issue_key` and the evidence hash match. When the evidence changes, for example an exposed file with different content, the finding returns.
- An excepted finding still appears in the report, labelled, but never raises an alert.

### 10. Audit log

Append-only, shown in its own tab. It records:
- every settings change, with old and new values;
- site additions and removals;
- every scan start, with who confirmed authorization and when;
- stops, exceptions and alerts.

Retention never deletes it.

### 11. Retention

- Scans and their findings older than the configured number of days (default 365) are deleted by the existing nightly retention job.
- The last completed scan of each site is always kept as the comparison baseline.

### 12. Dashboard (platform admin area, Arabic and English)

- **Global settings:** limits with the confirmation, check switches, default schedule, alert thresholds, contact, retention and the kill switch.
- **Sites:** list, add or remove, linked repository, overrides with their source, schedule, blocked and extra paths.
- **Scan:** start with the confirmation, live progress, stop, grouped findings with validation, risk and factors, the comparison, and HTML/JSON export.
  - The export has two layers: an executive summary, then technical findings with methodology and limitations.
  - All content is escaped in HTML exports.
- **Exceptions** and **Audit log** tabs.

All user-visible text lives in the dashboard i18n dictionaries.

## Testing

No test makes a real network request. Real `demo.testfire.net` or site requests are prohibited in tests.

- **Guarded client** (local ephemeral servers):
  - hosts outside the list, unlisted subdomains, lookalikes (`site.com.evil.io`);
  - off-list redirects and redirect limits;
  - DNS answers that resolve to private addresses;
  - timeouts, oversized bodies, the request cap and pacing;
  - `429` backoff and stop.
- **Checks:** fixed HTML and header fixtures for every check, including encoded, partial, attribute and duplicate reflections. A reflection never rises above Indicator.
- **Settings:**
  - ceilings rejected by the API and clamped by the worker;
  - the high-value confirmation;
  - global and per-site precedence.
- **Exceptions:** expiry, and the finding returning when the evidence hash changes.
- **Comparison:** New, Unchanged and Fixed, and stopped or failed scans never becoming a baseline.
- **Authorization:** a non-admin gets 404 on every route.
- **Redaction:** no token or cookie value is stored in evidence.
- **Worker:** concurrency 1, cancel and kill switch abort, `next_run_at` advancing in Kuwait time, alert dedup and the "fixed" comment.

## Rollout

Four pull requests, started after #188 and #189 are merged. The migration, ADR and decisions-log numbers are rebased then.

1. **`packages/webscan`:** guarded-client contract, crawler, checks, grouping, risk, comparison and report rendering.
2. **App storage and worker:** migration, store methods, queue, tick job, settings validation and ceilings, audit, retention.
3. **API and dashboard:** platform admin routes and the web pages, in Arabic and English.
4. **GitHub issue alerts:** needs the owner to add `Issues: write` to the App.

Everything ships switched off: no sites and no schedules. The owner runs the first real scan manually on `demo.testfire.net`, a site built for testing, to calibrate the checks, then on one of the owner's own sites.

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

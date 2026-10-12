# ADR-0010: SaaS custom base URL — SSRF guard on every call, one URL per workspace

## Context

J2 lets a workspace admin add a key for the `custom` (OpenAI-compatible) provider together with
its base URL. The SaaS then calls that URL from our servers: when listing models, when testing the
key (also before it is saved), and in the worker for every review. A URL chosen by a user is a
server-side request forgery risk: it could point at `169.254.169.254` (cloud metadata), the Docker
network, `localhost`, or a public name that later resolves to a private address (DNS rebinding),
or answer with a redirect to one. Checking the URL only when it is saved is not enough.

ADR-0008 (amendment) already makes the engine ignore `config.baseUrl`; the `custom` URL reaches
the engine only as the trusted `CreateReviewModelOptions.customBaseUrl`.

## Decision

- **Who may set it.** Only `custom` takes a base URL; a URL sent for a preset provider is refused
  (`base_url_not_allowed`). The URL is stored on the workspace's `custom` credential
  (`provider_credentials.base_url`), never in settings, never from `.mergepilot.yml`.
- **What is allowed.** `https:` only, no user info, no `localhost` / `*.local` / `*.internal` /
  `*.localdomain` / `home.arpa` names, and every resolved address must be public. Blocked:
  `0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (incl. metadata), `172.16/12`,
  `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`,
  `203.0.113/24`, `224/4`, `240/4`; IPv6 `::/96` (unspecified, loopback, IPv4-compatible),
  IPv4-mapped (checked as IPv4, dotted or hex form), `64:ff9b::/96`, `64:ff9b:1::/48`, `100::/64`,
  `2001::/32` (Teredo), `2001:db8::/32`, `2002::/16` (6to4), `fc00::/7` (incl. `fd00:ec2::254`),
  `fe80::/10`, `fec0::/10`, `ff00::/8`. One private answer among several rejects the host.
- **When it is checked.** On save, and again on **every outbound call** (model list, connection
  test, worker review) through a guarded fetch (`apps/app/src/core/safe-fetch.ts`): it resolves
  the host, checks every address, then connects with a lookup **pinned** to exactly those
  addresses (TLS still verifies the host name), and it **never follows redirects** (a 3xx is a
  failed response). The engine accepts this fetch as `CreateReviewModelOptions.customFetch`
  (used for `custom` only, primary and fallbacks); `listModels` / `testConnection` take it as
  `fetch`.
- **One URL per workspace.** A workspace has one `custom` credential, so every `custom` entry —
  primary, heavy-duty or fallback — uses that one URL. If the URL fails the check at review time,
  a `custom` primary fails the review clearly; a `custom` fallback is left out and the engine
  discloses the skipped fallback in the summary.
- **Keys typed before saving** (model list / "test before saving") are used for that one call:
  never stored, never logged (request bodies are not logged), every error message is redacted, and
  these routes are admin-only and rate-limited (tests 10/min, unsaved model lists 20/min per
  workspace). Listing models with the stored key is allowed to members (read-only, no secret).

## Consequences

- A rebinding DNS answer or a redirect cannot make our servers send a request, or a customer key,
  to an internal address.
- A self-hosted model server must be reachable on a public address over HTTPS; a server on a
  private network cannot be used from the SaaS (it can from the GitHub Action).
- Two custom servers per workspace are not possible; that would need a credential per URL.

# ADR-0032: Google Antigravity consumer-subscription login

**Date:** 2026-10-16 · **Status:** Proposed (design only; implementation waits for the owner's answers in decisions log س46) · **Owner decision:** س45 (third-party client IDs allowed), س46 (open questions)

**Related:** ADR-0004, ADR-0006, ADR-0008, ADR-0020, ADR-0024, ADR-0026, ADR-0027, `docs/subscription-auth.md`.

## Context

The owner asked for a Google subscription login that works the way the Codex, Claude and Grok subscriptions do (ADR-0020): the user signs in from the dashboard, MergePilot stores the tokens in the vault and calls the provider's own model protocol. On 2026-10-16 (س45) the owner removed the rule that banned other tools' OAuth client IDs. Leaked client secrets, reading other tools' login files and account pooling stay banned (ADR-0004 §4).

Research findings, 2026-10-16 (sources at the end):

1. **The Gemini CLI consumer path is gone.** Google stopped serving Gemini CLI and the Gemini Code Assist IDE extensions for Google AI Pro/Ultra subscribers and free "Code Assist for individuals" users on 2026-06-18. Code Assist Standard/Enterprise licences (bound to a Google Cloud project) and API-key users kept access. The successor for consumers is the Antigravity CLI (`agy`).
2. **Google's terms forbid exactly this use.** The Antigravity FAQ states that using third-party software, tools or services to access Antigravity violates the Terms of Service and may lead to suspension or termination; it recommends a Gemini Enterprise or AI Studio API key for third-party agents, and says wrapping headless `agy -p` or automating account switching is unsupported on consumer plans. Community reports describe 403 "ToS violation" suspensions of Antigravity/Gemini CLI access, appeals, and reinstatements. This is a stronger statement than the risk note recorded in س45, so the owner is asked again in س46 before any code is written.
3. **`agy` is closed source.** `github.com/google-antigravity/antigravity-cli` holds docs, examples and the changelog, not the source. Official docs say `agy` signs in with a Google account (Free, Pro, Ultra, or business through Gemini Enterprise), keeps tokens in the OS keyring, and on SSH prints an authorization URL whose browser page shows a code the user pastes back.
4. **The protocol is public through Gemini CLI (Apache-2.0) and third-party MIT plugins:**
   - **OAuth:** Google's standard authorization endpoint, Authorization Code + PKCE S256 + `state`, token exchange and refresh at `https://oauth2.googleapis.com/token`. Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile` (the third-party Antigravity plugins also ask for `cclog` and `experimentsandconfigs`). Both clients are Google "installed application" clients whose client ID and non-confidential client secret ship inside the official tool. Gemini CLI's client publishes them in its source; the Antigravity values are those that ship inside the Antigravity application, as used by the third-party plugins.
   - **Redirects:** Gemini CLI's no-browser flow redirects to the Google-hosted page `https://codeassist.google.com/authcode`, which shows a code to paste (verified in source). The third-party Antigravity plugins use a loopback redirect `http://localhost:51121/oauth-callback` and, when headless, ask the user to paste the failed redirect URL (code + state). Whether the Antigravity client also accepts a Google-hosted code page, as `agy`'s SSH flow suggests, is **not verified**.
   - **API:** Cloud Code Assist, `https://cloudcode-pa.googleapis.com/v1internal:{method}`; the Antigravity clients also use the daily sandbox host `daily-cloudcode-pa.sandbox.googleapis.com`. Methods: `loadCodeAssist` (tier and project discovery), `onboardUser` (long-running operation, polled), `streamGenerateContent?alt=sse`, `generateContent`, `countTokens`, `retrieveUserQuota`, and `fetchAvailableModels` (Antigravity model catalog).
   - **Request envelope:** `{ model, project, user_prompt_id, request: { contents, systemInstruction, generationConfig: { maxOutputTokens, temperature, thinkingConfig } } }`. Antigravity clients add `userAgent` and `requestId`, and send `User-Agent` (an Antigravity build string), `X-Goog-Api-Client` and `Client-Metadata` (IDE, platform, plugin type) headers.
   - **Response:** SSE `data:` lines of `{ response: { candidates, usageMetadata, modelVersion, responseId }, traceId }`. Claude models served by Antigravity use the same Gemini-style body (`contents` with `user`/`model` roles, `systemInstruction.parts`); thinking parts carry `thought: true`.
   - **Models:** account-dependent; currently Gemini Flash/Pro versions, Claude Sonnet/Opus and `gpt-oss-120b`. The FAQ says some models (Gemini 4 Argon, Claude Opus 5.5, Claude Sonnet 5.5) need a paid Pro/Ultra plan. `fetchAvailableModels` returns the account's list with quota groups.
   - **Errors:** Google RPC error objects `{ error: { code, message, status, details } }`. Quota and rate limit: HTTP 429 `RESOURCE_EXHAUSTED` with a `google.rpc.RetryInfo` `retryDelay` and a "quota will reset after …" message. Account verification: 403 with `VALIDATION_REQUIRED` and a validation URL. Suspension: 403 naming a Terms of Service violation. Onboarding: ineligible-tier and project-required errors from `loadCodeAssist`/`onboardUser`.
5. **No library to delegate to.** `@earendil-works/pi-ai` 1.1.0 (installed) and 1.3.0 have no Google OAuth provider; pi v0.71.0 removed its built-in "Google Gemini CLI" and "Google Antigravity" providers without a stated reason. The MIT packages that restore them (`pi-antigravity`, `@yofriadi/pi-provider-antigravity`, `@raquezha/antigravity`, the archived `opencode-antigravity-auth`) are plugins for the pi or OpenCode agents, built around a local callback server, multi-account rotation and their own stores. None is a maintained library that fits MergePilot's vault, lock and headless web login, and their multi-account rotation is banned here.

## Decision (proposed)

1. **A separate provider id, subscription only.** Add `google-antigravity` to `SUBSCRIPTION_PROVIDERS`, to the dashboard `SubscriptionProviderSchema` and to the provider registry, with the display name "Google Antigravity". `gemini` stays an API-key provider with its ADR-0026 key list. Antigravity model ids (`claude-*`, `gpt-oss-*`, Antigravity-specific Gemini ids) do not match Gemini API ids, so ADR-0027's "same provider and model on the other method" cannot hold. `google-antigravity` is **not** in `DUAL_METHOD_PROVIDER_IDS` in this ADR. A workspace that wants a paid backup configures an explicit, disclosed ADR-0008 fallback to `gemini:<model>`. One Google account per workspace; no account rotation (ADR-0004 §4, and the FAQ's ban on automated account switching).

2. **Code location.** Everything protocol-specific lives in `packages/engine/src/providers/subscription/antigravity/`:
   - `oauth.ts`: the PKCE URL, the code exchange, refresh, and onboarding (`loadCodeAssist`, then `onboardUser` with polling).
   - `client.ts`: the Code Assist SSE client.
   - `models.ts`: `fetchAvailableModels` and a static fallback list.
   - `errors.ts`: Google RPC error to `LlmFailure` mapping.
   The engine does not import from `apps/` (ADR-0001). `subscription/auth.ts` dispatches `loginSubscription` and `refreshSubscription` to this module for `google-antigravity`; the other providers keep going through pi-ai. The `select`-prompt branch and `subscriptionProvider()` stop falling through to xAI for unknown ids. Code is written from the protocol description above. Nothing is copied from Gemini CLI (Apache-2.0, outside the MIT copying rule) or from the plugins; if an MIT file is ever copied verbatim, its notice is kept and `THIRD_PARTY_NOTICES.md` gets a row.

3. **Client credentials.** The OAuth client ID and its non-confidential installed-app secret are read from server configuration (`GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_ID`, `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_SECRET`), not committed to the repository (pending س46-ب). When they are absent, the provider is hidden from the subscription method list and the login route answers `400 invalid_provider`. These values are never logged or returned to the dashboard.

4. **Login on a web server.** MergePilot never binds a callback port. The server builds the PKCE authorization URL (S256 verifier kept in the attempt, random `state`) and the existing `SubscriptionLogins` state machine carries it unchanged: `notify({ type: 'auth_url' })`, then one `prompt` for the pasted value. Two variants, chosen by س46-ب:
   - **(a) Google-hosted code page** (redirect `https://codeassist.google.com/authcode` or the equivalent Antigravity page, if the chosen client accepts it): the user pastes the short code. Same UX as Claude copy-code.
   - **(b) Loopback redirect** (`http://localhost:51121/oauth-callback`): after sign-in the browser shows a "can't connect" page; the user copies the full address-bar URL into the dashboard. The server parses it, rejects a missing or mismatched `state`, and exchanges the `code`. The dashboard text warns that a program listening on that port on the user's machine would receive the code.
   After the exchange the server calls `loadCodeAssist`, and `onboardUser` when needed, to get `projectId` and the tier. Ineligible-tier, verification-required and project-required answers fail the attempt with a fixed message; the Google body is never shown. Attempts keep today's rules: admin only, bound to user and workspace, 15-minute expiry, cancellable, sticky routing for multiple web replicas, saved only by the authenticated `finish` request.

5. **Persistence.** The existing `mergepilot:oauth:v1:` envelope inside the vault column: `{ provider: 'google-antigravity', credential: { type: 'oauth', access, refresh, expires, projectId, tier } }` (the schema's catchall already allows extra fields). The account email is not stored. `credentialSecretValues` already redacts `access` and `refresh` individually; `projectId` is not a secret. Backups, restore and master-key rotation need no change beyond the provider enum.

6. **Refresh.** The existing `CredentialService.resolve` path: lock-free read while `expires` is more than 60 seconds away, otherwise `coordinateRefresh` under the workspace/provider advisory lock, then `refreshSubscription` → `POST https://oauth2.googleapis.com/token` (`grant_type=refresh_token`). `expires = now + expires_in`. Google normally keeps the same refresh token; when the response carries a new one it replaces the old one. `invalid_grant` or any refresh failure keeps the stored credential and raises "sign in again"; the upstream body is dropped. The adapter keeps `resolveSecret`, so a long review refreshes between calls.

7. **Request protocol.** `GoogleAntigravityAdapter extends LlmAdapter` streams `POST {host}/v1internal:streamGenerateContent?alt=sse` with the envelope above.
   - System messages go to `systemInstruction.parts` and the other messages to `contents` (`assistant` → `model`).
   - `maxOutputTokens` and the effort map to `thinkingConfig` with the existing Gemini helpers, keeping `maxOutputTokens` above `thinkingBudget`. Parts with `thought: true` are not yielded as review text.
   - `usageMetadata` maps to `TokenUsage` (thought tokens count as output).
   - Headers: `Authorization: Bearer`, `Content-Type`, `Accept: text/event-stream`, and the `User-Agent`, `X-Goog-Api-Client` and `Client-Metadata` values of the chosen client. Sending another tool's identity headers is allowed by س45; it is also the part Google can change or detect at any time.
   - Hosts: a fixed list in code, `daily-cloudcode-pa.sandbox.googleapis.com` then `cloudcode-pa.googleapis.com`, not configurable from `.mergepilot.yml` or the dashboard. The next host is tried only on a network error, 404 or 5xx **before any response byte was streamed**, and the switch is logged with the host name. 401, 403 and 429 never move to another host.
   - No tools, function declarations or Google Search grounding are sent: review calls are text only, and no reviewed code is executed.

8. **Failure classification.** `errors.ts` reads `error.status`, `error.details[]` and the HTTP status. It never puts the body in the message without `redactSecrets`.
   - 429 `RESOURCE_EXHAUSTED` → `RATE_LIMIT` when `retryDelay` is at most 60 s (retried by the existing policy, honouring the delay up to its cap), otherwise `QUOTA`. Test the existing `code429` wording regex against these bodies rather than assume it matches.
   - 401, or `invalid_grant` on refresh → `INVALID_CREDENTIAL`, "sign in again".
   - 403 `VALIDATION_REQUIRED` → `INVALID_CREDENTIAL`, "Google asks you to verify this account in the browser, then sign in again". The validation URL from the body is not forwarded.
   - 403 naming a Terms of Service violation or a disabled service → `INVALID_CREDENTIAL`, "Google disabled Antigravity access for this account". Kind `auth`, so ADR-0027's quota-only triggers never pay around it, and the failure is never silent.
   - 404 unknown model → `BAD_REQUEST` naming the model. 400 `INVALID_ARGUMENT` → `BAD_REQUEST`, or `CONTEXT_WINDOW_EXCEEDED` on token-limit wording.
   - 500/502/503 `UNAVAILABLE`/overloaded → `SERVER`. 408/504 → `TIMEOUT`. Fetch errors → `NETWORK`. Abort → `ABORTED`.
   - A stream that ends without a final candidate → `UNKNOWN`. Finish reason `SAFETY`/`RECITATION`/`PROHIBITED_CONTENT` → finish `error`, as in `GeminiAdapter`.

9. **Models.** `listModels` calls `fetchAvailableModels` with the resolved token and caches the result per workspace for 4 hours. The existing models-cache invalidation runs on connect and disconnect. When the call fails, a static list in `models.ts` is returned and the UI notes it may be stale. Thinking variants of one model are shown once, with the efforts the model reports. The effort list reuses `effort.ts`.

10. **Pricing and accounting.** ADR-0024 unchanged in spirit: `includedInSubscription: true`, `authMethod: 'subscription'`, price source `subscription`, $0 incremental cost, token usage kept. For the API-equivalent figure a new map, `SUBSCRIPTION_API_PROVIDER` (`claude-*` → `anthropic`, `gemini-*` → `gemini`, `gpt-oss-*` → none), finds the catalog row of the same model under its API provider, after the workspace's manual price. When no row matches, the figure is absent, never $0. Monthly-budget admission treats the bot as a free subscription bot (ADR-0022), since no paid method exists on this provider.

11. **Dashboard.**
    - Settings → Provider credentials → Add credential lists "Google Antigravity" with the Subscription method only.
    - Before **Start sign-in**, a notice states that Google's terms forbid third-party access to Antigravity and that Google may suspend the account's Antigravity access. The user must tick an acknowledgement checkbox (pending س46-أ); the tick is required by the client and checked by the start route.
    - The sign-in step reuses `SubscriptionSignIn`: open the Google page, paste the code (or the redirect URL in variant b), Continue. The provider label, notice, paste help and the ToS-suspension and verification errors are new keys in `apps/web/src/i18n/en.ts` and `ar.ts`.
    - The model list comes from point 9.
    - `apps/app/src/api/contract-subscriptions.ts` and the web client change together.

12. **Docs.** On acceptance: update `docs/subscription-auth.md` (provider, steps, the ToS warning), `docs/architecture.md` (the `subscription/antigravity/` folder), and `AGENTS.md` (subscription provider list). Amend ADR-0006's "Gemini has no subscription mode" lines (Context and Decision §5) to point here.

## Tests to write (phase 2)

- **Engine, OAuth:**
  - the PKCE URL has S256, `state`, scopes and the configured client;
  - the exchange sends the verifier;
  - the pasted redirect URL is parsed, and a mismatched or missing `state` is rejected (variant b);
  - `onboardUser` polls until done, and the ineligible, validation and project-required answers fail with fixed messages;
  - refresh success, `invalid_grant`, and a rotated refresh token.
- **Engine, request protocol:** envelope shape, `project`, roles, `systemInstruction`, `thinkingConfig` bounds, headers, SSE parsing across chunk boundaries, usage mapping, thought parts dropped, and the host order rule (no host switch after the first byte or on 401/403/429).
- **Engine, failure classification:** a fixture per row of point 8, including the `retryDelay` threshold and the suspension 403. No token or body secret appears in `LlmFailure.message`.
- **App (AGENTS.md list):**
  - admin-only start, input, finish and cancel;
  - user and workspace isolation of attempts;
  - cancellation and expiry;
  - encrypted persistence of the envelope with `projectId`;
  - concurrent refresh sharing one promise under the lock, across a web and a worker store;
  - redaction of `access` and `refresh` in prompts, output, errors and logs;
  - the provider hidden when the client configuration is absent;
  - the acknowledgement required by the start route.
- **Web:** the sign-in step with the notice and checkbox, paste and continue, the new error texts in en and ar, and the model list after connect.
- **Pricing:** an API-equivalent from the `anthropic` row for a `claude-*` model, and absent for `gpt-oss-*`.

## Consequences

- Workspaces gain a Google consumer-subscription bot, with Claude and Gemini models billed to the user's Google AI plan.
- Google's terms forbid this use. Access can be suspended for the Google account's Antigravity service, Google can change the client, headers or endpoints at any time, and the feature can break without notice. Every such failure surfaces as `LlmFailure`; nothing falls back silently.
- MergePilot owns this protocol code instead of delegating it to pi-ai, which conflicts with AGENTS.md's "delegate OAuth protocol details to pi-ai" until the owner accepts this exception (س46). A future pi-ai Google provider would replace it.
- The Code Assist Standard/Enterprise path (business accounts with their own Google Cloud project) uses the same protocol and could be added later with a user-supplied project id field (س46-هـ).

## Sources (read 2026-10-16)

- Gemini CLI source, Apache-2.0: `google-gemini/gemini-cli` `packages/core/src/code_assist/{oauth2,server,setup,converter}.ts`.
- Antigravity CLI docs: https://antigravity.google/docs/install?tab=cli ; FAQ: https://antigravity.google/docs/faq ; repository: https://github.com/google-antigravity/antigravity-cli
- Gemini CLI end of consumer service, 2026-06-18: https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx and https://letsdatascience.com/news/google-replaces-gemini-cli-with-antigravity-cli-574b2056
- pi v0.71.0 release notes: https://pi.dev/changelog/releases/0.71.0
- Third-party MIT plugins, used only to understand the protocol: https://github.com/NoeFabris/opencode-antigravity-auth (archived; `docs/ANTIGRAVITY_API_SPEC.md`), https://cdn.jsdelivr.net/gh/Rahularya01/pi-antigravity@main/README.md , https://cdn.jsdelivr.net/gh/yofriadi/pi-extensions@master/README.md
- Suspension reports: https://discuss.ai.google.dev/t/antigravity-gemini-code-assist-disabled-403-tos-violation-appeal-assistance-needed/124025

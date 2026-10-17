# ADR-0032: Google Antigravity consumer-subscription login

**Date:** 2026-10-16 · **Status:** Accepted (owner, 2026-10-16, decisions log س47) · **Owner decisions:** س45 (third-party client IDs allowed), س47 (scope and design)

**Related:** ADR-0004, ADR-0006, ADR-0008, ADR-0020, ADR-0022, ADR-0024, ADR-0026, ADR-0027, `docs/subscription-auth.md`.

## Context

The owner asked for a Google subscription login that works the way the Codex, Claude and Grok subscriptions do (ADR-0020): the user signs in from the dashboard, MergePilot stores the tokens in the vault and calls the provider's own model protocol. On 2026-10-16 (س45) the owner removed the rule that banned other tools' OAuth client IDs. Leaked client secrets, reading other tools' login files and account pooling stay banned (ADR-0004 §4).

Research findings, 2026-10-16 (sources at the end):

1. **The Gemini CLI consumer path is gone.** Google stopped serving Gemini CLI and the Gemini Code Assist IDE extensions for Google AI Pro/Ultra subscribers and free "Code Assist for individuals" users on 2026-06-18. Code Assist Standard/Enterprise licences (bound to a Google Cloud project) and API-key users kept access. The successor for consumers is the Antigravity CLI (`agy`).
2. **Google's terms forbid exactly this use.** The Antigravity FAQ states that using third-party software, tools or services to access Antigravity violates the Terms of Service and may lead to suspension or termination. It recommends a Gemini Enterprise or AI Studio API key for third-party agents, and says wrapping headless `agy -p` or automating account switching is unsupported on consumer plans. Community reports describe 403 "ToS violation" suspensions of Antigravity/Gemini CLI access, appeals, and reinstatements. This is a stronger statement than the risk note recorded in س45, so the owner was asked again in س47 (answer: go ahead, with the acknowledgement below).
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

## Decision

The owner accepted every recommendation in س47 and confirmed (د): the new provider is sign-in only.

1. **A separate provider, subscription only.**
   - `google-antigravity` ("Google Antigravity") is in `API_PROVIDER_IDS`, `SUBSCRIPTION_PROVIDERS` and the new `SUBSCRIPTION_ONLY_PROVIDERS` (`packages/engine/src/credentials/subscription.ts`), and in the dashboard's `SubscriptionProviderSchema`.
   - It has **no API-key method**. `PUT /keys/google-antigravity` answers `400 subscription_only`, `CredentialService.sealKey` refuses a plain key (a backup restore of its sealed envelope still works), and a connection test with a typed key answers `auth`.
   - It is not in `DUAL_METHOD_PROVIDER_IDS` or `MULTI_KEY_PROVIDER_IDS`.
   - `gemini` is unchanged: API keys only, with its ADR-0026 list.
   - No paid fallback is set up by default. A workspace may still configure one, for example to `gemini:<model>`, like any ADR-0008 fallback; it is disclosed as one.
   - One Google account per workspace. There is no account rotation (ADR-0004 §4, and the FAQ's ban on automated account switching).

2. **Code location.** The protocol lives in `packages/engine/src/providers/subscription/antigravity/`:
   - `config.ts`: client configuration, fixed hosts, identity headers.
   - `oauth.ts`: PKCE URL, pasted-address parsing, code exchange, refresh, `loadCodeAssist`/`onboardUser`, and `SubscriptionLoginError`.
   - `transport.ts`: the host-list rule.
   - `protocol.ts`: request body, thinking config, SSE parsing, usage.
   - `adapter.ts`: `AntigravityAdapter`.
   - `models.ts`: `fetchAvailableModels`, the cache and the static list.
   - `errors.ts`: Google RPC error → `LlmFailure`.

   `subscription/auth.ts` dispatches `loginSubscription`/`refreshSubscription` for `google-antigravity` to this module; the other subscriptions keep pi-ai. `createSubscriptionAdapter` and `isSubscriptionAdapter` (`subscription/adapter.ts`) pick the adapter and mark it as subscription-billed. The engine does not import from `apps/` (ADR-0001).

   This is a written exception to AGENTS.md's "delegate OAuth protocol details to pi-ai" (س47-ح); if pi-ai adds a maintained Google provider, this module moves to it. The code is written from the protocol description above. Nothing is copied from Gemini CLI (Apache-2.0, outside the MIT copying rule) or from the plugins.

3. **Client credentials.** The OAuth client ID and its non-confidential installed-app secret come from server configuration, `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_ID` and `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_SECRET`, never from the repository (س47-ب). Without both:
   - `GET /api/workspaces/:ws/subscriptions` leaves the provider out, so the add-credential dialog does not offer it;
   - `POST …/subscriptions/google-antigravity` answers `400 invalid_provider`;
   - a refresh fails with "sign in again".

   The values are sent only to Google's token endpoint and are never logged or returned.

4. **Login on a web server.** MergePilot never binds a callback port, so it uses the paste-the-address variant with the loopback redirect `http://localhost:51121/oauth-callback`. This is the variant the Antigravity client is known to accept; a Google-hosted code page for this client is not verified.
   1. The server builds the authorization URL: PKCE S256, a random `state`, `access_type=offline`, `prompt=consent`.
   2. The existing `SubscriptionLogins` state machine shows the link (`auth_url`) and one text prompt.
   3. The user signs in. The browser then fails to open the localhost page, and the user pastes that address.
   4. `codeFromPastedUrl` rejects an address with no `code` or with a missing or wrong `state`, then the code is exchanged with the verifier.
   5. `loadCodeAssist` gives the project and tier. A new account is onboarded on its default tier with `onboardUser`, polled every 5 s for up to 2 minutes.

   Failures carry a fixed `SubscriptionLoginError.reason`: `denied`, `state-mismatch`, `invalid-paste`, `token-exchange`, `validation-required`, `ineligible` or `project-required`. A tier that needs the user's own Google Cloud project (a business account) fails with `project-required`; only personal accounts are in scope (س47-هـ). The login snapshot exposes only `errorCode`, never Google's body.

   The terms acknowledgement is required twice: the dashboard enables **Sign in** only after the checkbox is ticked, and the start route refuses a request without `acknowledgedTerms: true` (`400 terms_not_acknowledged`). Everything else is today's rule: admin only, bound to user and workspace, 15-minute expiry, cancellable, sticky routing for several web replicas, saved only by the authenticated `finish` request.

5. **Persistence.** The existing `mergepilot:oauth:v1:` envelope in the vault column: `{ provider: 'google-antigravity', credential: { type: 'oauth', access, refresh, expires, projectId, tier } }`. The account email is not stored. `credentialSecretValues` redacts `access` and `refresh` individually. The single-credential paths (backup export/restore, master-key rotation in `vault/rotate.ts`, delete) need no provider-specific code.

6. **Refresh.** `CredentialService.resolve` unchanged: a lock-free read while `expires` is more than 60 s away, otherwise `coordinateRefresh` under the workspace/provider advisory lock, then a refresh grant to Google's token endpoint (`oauth2.googleapis.com`). The new expiry is now plus the lifetime Google returns. When Google sends a new refresh value it replaces the stored one; otherwise the old one is kept, with the project. Any failure keeps the stored credential and raises `SubscriptionRefreshError`:
   - **permanent** for 400/401 (`invalid_grant`) or a 200 without an access token: "Subscription token refresh failed; sign in again";
   - **transient** for no answer, an unreadable (non-JSON) answer, 408, 429 or 5xx: "could not reach the provider; try again";
   - **not configured** when the server lacks the OAuth client: "Google Antigravity sign-in is not configured on this server". This is an operator problem, so the adapter reports it as `PROVIDER_NOT_CONFIGURED` (failure kind `server`, which a configured fallback still covers) rather than asking the user to sign in again. A sign-in started then fails with the `not-configured` reason.

   The adapter resolves the secret again before each call. A permanent refresh failure becomes `INVALID_CREDENTIAL`. A transient one becomes `NETWORK`, and any other error while loading the credential (lock, database) becomes `SERVER`, so both are retried. pi-ai refresh errors carry no classification and stay permanent.

7. **Request protocol.** `AntigravityAdapter` streams `POST {host}/v1internal:streamGenerateContent?alt=sse`:
   - The body is `{ project, model, userAgent: 'antigravity', requestId, request: { contents, systemInstruction?, generationConfig } }`. System messages go to `systemInstruction.parts`, and `assistant` becomes `model`.
   - Thinking:
     - Gemini models take `geminiThinkingConfig`.
     - Claude models take `thinkingBudget = thinkingHeadroom(effort)` (none for `off`), always with `includeThoughts: false`.
     - `maxOutputTokens` is the answer budget plus that headroom, and `requestedOutputTokens` returns the same number, so the budget preflight prices it.
   - Parts with `thought: true` are not yielded. `usageMetadata` maps like `GeminiAdapter`: cached tokens are not counted as input, and thought tokens count as output.
   - Headers: `Authorization`, `Content-Type`, `Accept: text/event-stream`, and the Antigravity `User-Agent`, `X-Goog-Api-Client` and `Client-Metadata` values in `config.ts` (allowed by س45). Their exact values are not verified against a current Antigravity build, and Google may change or check them.
   - Hosts: a fixed list in code, `daily-cloudcode-pa.sandbox.googleapis.com` then `cloudcode-pa.googleapis.com`, for chat, onboarding and the model list. It is not configurable from `.mergepilot.yml` or the dashboard.
     - The next host is tried only on a network error, 404 or 5xx, before any of the body was read.
     - 401, 403 and 429 never move to another host, nor does an aborted call.
     - The engine does not log the switch; it has no logger.
   - No tools, function declarations or search grounding are sent, and no reviewed code is executed.

8. **Failure classification** (`errors.ts`). Bodies are read only for classification. Every message is a fixed text. It carries at most the HTTP status, the RPC `status` enum name (only when it matches `^[A-Z_]+$`) and the model id. No body text is forwarded on any path, so an echoed token cannot survive a truncation.

   | Answer | `LlmFailure` code | Message or note |
   |---|---|---|
   | 429 or `RESOURCE_EXHAUSTED`, `retryDelay` ≤ 60 s | `RATE_LIMIT` | `retryAfterMs` set from the delay |
   | 429, `retryDelay` > 60 s, "reset after …" in the message, or `ErrorInfo` reason `QUOTA_EXHAUSTED` | `QUOTA` | |
   | 429 with no timing | `RATE_LIMIT` | Google's generic text mentions "quota" even for short limits |
   | 401 | `INVALID_CREDENTIAL` | "sign in again" |
   | 403 `VALIDATION_REQUIRED` | `INVALID_CREDENTIAL` | "verify this account in the browser"; the link is not forwarded |
   | 403 suspension or Terms of Service wording | `INVALID_CREDENTIAL` | "Google disabled Antigravity access for this account" |
   | other 403 | `INVALID_CREDENTIAL` | |
   | 404 | `BAD_REQUEST` | names the model |
   | 400 | `BAD_REQUEST`, or `CONTEXT_WINDOW_EXCEEDED` on token-limit wording | |
   | 408, 504 | `TIMEOUT` | |
   | other 5xx | `SERVER` | |
   | fetch error | `NETWORK` | |
   | abort | `ABORTED` | |
   | an error event inside the stream | as its status | |
   | a stream that ends without a candidate `finishReason` (no answer, or cut off mid-answer) | `NETWORK` | retried |
   | a malformed SSE event | `UNKNOWN` | never skipped |
   | finish `STOP` / `MAX_TOKENS` | finish `stop` / `max-tokens` | the only clean ends |
   | finish `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `LANGUAGE`, or `promptFeedback.blockReason` | `BAD_REQUEST` | "declined to answer (REASON)", not retried |
   | any other finish (`OTHER`, `MALFORMED_FUNCTION_CALL`, `FINISH_REASON_UNSPECIFIED`, …) | `UNKNOWN` | "ended the answer abnormally (REASON)" |
   | a 2xx body that is not JSON (token, Code Assist, model list) | fixed error | no parse message or cause kept |

   A failed or unread response body is cancelled before the error is thrown; the status stays the deciding signal.

   Every 403 has kind `auth`, so nothing pays its way around a suspension.

9. **Models.**
   - `listModels('google-antigravity', envelope)` calls `fetchAvailableModels` and keeps chat models (`gemini-*`, `claude-*`, `gpt-oss-*`, no image/embedding/TTS ids).
   - The result is cached per project for 4 hours. A failed refresh returns the last list that worked, and with none, the static list in `models.ts`. A real access problem then shows on the connection test or the review.
   - Efforts: Gemini models get the Gemini levels, Claude models `off/low/medium/high`, and `gpt-oss-*` none.
   - The registry default model is `gemini-3.8-flash`.

10. **Pricing and accounting (ADR-0024).**
    - Calls are subscription-billed: `includedInSubscription`, `authMethod: 'subscription'`, run price source `subscription`, and $0 incremental cost, with token usage kept. Budget admission treats the bot as free (ADR-0022).
    - The display-only API-equivalent uses the same model at its own vendor (س47-ز). `antigravityApiModel` in `apps/app/src/worker/api-equivalent.ts` maps `claude-*` to `anthropic` and `gemini-*` to `gemini`, and prices `-thinking` variants as their base model. `gpt-oss-*` has no API vendor, so no equivalent is shown, never $0.

11. **Dashboard.**
    - **Add credential.** The dialog offers "Google Antigravity" only when `GET …/subscriptions` lists it. It then shows sign-in only, with no API-key field.
    - **Every provider select** (main bot, heavy model, fallbacks, extra bots, add-credential) filters subscription-only providers by the same `GET …/subscriptions` answer (`ProviderSelect` with `workspaceId`). A saved `google-antigravity` choice stays visible, with a note that this server does not offer it.
    - **The server enforces the same rule.** `PUT /settings` and `PUT /bots/:slot` refuse a newly chosen subscription-only provider the server does not offer (`400 provider_unavailable`). A choice already saved is kept, so other changes can still be saved.
    - **Before sign-in.** An amber notice states the Terms-of-Service risk, and an "I understand the risk to this Google account" checkbox enables **Sign in with Google (Antigravity)**.
    - **Sign-in step.** The step asks for the address from the browser and explains the localhost page and the port-51121 caveat. Each failure reason has its own translated text.
    - **Code.** All text lives in `apps/web/src/i18n/antigravity-{en,ar}.ts`. `apps/app/src/api/contract-subscriptions.ts` (`SubscriptionStartSchema`, `SubscriptionAvailabilitySchema`, `errorCode`, `SUBSCRIPTION_ONLY_PROVIDER_IDS`) and the web client changed together. The web keeps a copy of the subscription-only list, checked against the contract by type.

12. **Action.** The registry entry names `GOOGLE_ANTIGRAVITY_SUBSCRIPTION` as the provider's environment variable. `AntigravityAdapter` does not refresh tokens itself (refresh lives in the dashboard's credential service), so the Action can use such an envelope only while its access token is still valid. The supported path is the dashboard.

## Tests

- **Engine, OAuth** (`antigravity/oauth.test.ts`):
  - the URL parameters (S256, state, scopes, offline, no secret);
  - pasted-address parsing (match, mismatch, missing state, missing code, bare code, refusal);
  - the exchange with the verifier and client;
  - existing-tier and onboarding-with-polling paths;
  - validation-required, ineligible and project-required;
  - a 403 from `loadCodeAssist` without its body, and a 503 there reported as a generic failure;
  - no token request on a mismatched paste;
  - refused or refresh-less exchanges;
  - refresh keeping, rotating and failing.
- **Engine, request protocol** (`antigravity/adapter.test.ts`):
  - envelope, roles, system instruction, thinking config and output-token bounds, headers;
  - SSE across read boundaries, thought parts dropped, usage, finish mapping;
  - the host rule (503, 404 and network move on; 401, 403 and 429 do not; all failing gives `NETWORK`);
  - an in-stream quota error;
  - a stream without a `finishReason` (none at all, or after text);
  - a malformed event;
  - the body cancelled on early stop and on an error event;
  - a missing project;
  - permanent vs transient refresh failures and a credential-load error;
  - the per-call resolved credential.
- **Engine, failure classification** (`antigravity/errors.test.ts`): rate limit vs quota by `retryDelay`, reset wording and reason; a bare 429; 401; verification and suspension 403s without the body; 404, 400 context, 503 and 504; no body text forwarded for any status, including a token echoed across the old 300-character cut.
- **Engine, models and configuration** (`antigravity/models.test.ts`, `subscription/auth.test.ts`): map and array parsing, the 4-hour cache, last-good and static fallback; availability without the client values, and no request when unconfigured.
- **App** (`api/subscription-routes-antigravity.test.ts`, `credentials/subscription-antigravity.test.ts`):
  - admin-only availability and start;
  - hidden or refused when unconfigured;
  - the required acknowledgement;
  - encrypted persistence with the project and no tokens in responses;
  - the fixed `errorCode` on failure;
  - API keys refused, also on restore;
  - one refresh for two service instances that keeps the refresh token and project;
  - a failed refresh preserving the row;
  - disconnect serialized after a pending refresh;
  - master-key rotation;
  - redaction of both tokens.

  Workspace isolation of login attempts is covered by the shared `subscription-routes.test.ts`.
- **Web** (`settings/AntigravitySignIn.test.tsx`): the checkbox gating and the acknowledgement sent; the paste field and its submission; the translated failure reason; the provider offered only when available, with no API-key field.

## Consequences

- Workspaces gain a Google consumer-subscription bot that serves Claude and Gemini models on the user's Google AI plan.
- Google's terms forbid this use, and the dashboard says so before every sign-in. Google can suspend the account's Antigravity access, and it can change the client, headers or hosts at any time, so the feature can break without notice. Every such failure surfaces as `LlmFailure`; nothing falls back silently.
- MergePilot owns this protocol code instead of pi-ai (AGENTS.md exception, س47-ح).
- Business accounts (Code Assist Standard/Enterprise with their own Google Cloud project) use the same protocol. They can be added later with a user-supplied project id (س47-هـ).
- ADR-0006's "Gemini has no subscription mode" lines are amended to point here.

## Sources (read 2026-10-16)

- Gemini CLI source, Apache-2.0: `google-gemini/gemini-cli` `packages/core/src/code_assist/{oauth2,server,setup,converter}.ts`.
- Antigravity CLI docs: https://antigravity.google/docs/install?tab=cli ; FAQ: https://antigravity.google/docs/faq ; repository: https://github.com/google-antigravity/antigravity-cli
- Gemini CLI end of consumer service, 2026-06-18: https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx and https://letsdatascience.com/news/google-replaces-gemini-cli-with-antigravity-cli-574b2056
- pi v0.71.0 release notes: https://pi.dev/changelog/releases/0.71.0
- Third-party MIT plugins, used only to understand the protocol: https://github.com/NoeFabris/opencode-antigravity-auth (archived; `docs/ANTIGRAVITY_API_SPEC.md`), https://cdn.jsdelivr.net/gh/Rahularya01/pi-antigravity@main/README.md , https://cdn.jsdelivr.net/gh/yofriadi/pi-extensions@master/README.md
- Suspension reports: https://discuss.ai.google.dev/t/antigravity-gemini-code-assist-disabled-403-tos-violation-appeal-assistance-needed/124025

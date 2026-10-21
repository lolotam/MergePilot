# Provider subscription authentication

MergePilot's dashboard offers **API key** and **Subscription** methods for OpenAI, Anthropic, and xAI, and a **subscription-only** Google Antigravity provider (ADR-0032). Other providers, including Google Gemini, retain their API-key method. OpenAI, Anthropic and xAI sign-in uses the provider-owned flows and request protocols in `@earendil-works/pi-ai`, the same provider library used by the DeepSeek Harness reference app. pi-ai has no Google provider, so Google Antigravity's sign-in and Cloud Code Assist requests are MergePilot's own code (`packages/engine/src/providers/subscription/antigravity/`).

## Connect an account

1. Open **Settings → Provider credentials → Add credential**.
2. Choose **OpenAI**, **Anthropic**, or **xAI**, then select **Subscription** under **Authentication method**.
3. Start sign-in and open the provider's sign-in page:
   - **OpenAI / Codex:** sign in with ChatGPT and enter the displayed device code. Device-code authentication must be enabled in your ChatGPT account settings.
   - **Anthropic / Claude:** sign in with Claude Pro/Max, then paste the authorization code into MergePilot.
   - **xAI / Grok:** sign in with SuperGrok or X Premium and enter the displayed device code.
4. When sign-in succeeds, MergePilot saves the encrypted credentials and closes the dialog. Select a model from the refreshed model list, save your review settings, and use **Test connection** to verify access.

### Google Antigravity

Google's terms forbid using third-party tools to access Antigravity, and Google may suspend or terminate the account's Antigravity access. MergePilot shows this before every sign-in and starts only after you tick **I understand the risk to this Google account**.

1. The server operator sets `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_ID` and `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_SECRET` (the installed-app client that ships inside the Antigravity application). Without both, the provider is not offered. The values are never stored in the repository.
2. In **Add credential**, choose **Google Antigravity**. It has no API-key field.
3. Tick the acknowledgement, select **Sign in with Google (Antigravity)** and sign in with a personal Google account (Free, Pro or Ultra). Business accounts that need their own Google Cloud project are not supported yet.
4. The browser then opens a `http://localhost:51121/oauth-callback?...` page that cannot load. Copy the whole address from the address bar and paste it into MergePilot. MergePilot checks that it belongs to this sign-in. A program listening on port 51121 on your computer would receive the code instead.
5. MergePilot finds or creates the account's Cloud Code Assist project, saves the encrypted credentials, and lists the account's models (Gemini, Claude and GPT-OSS models, as Google offers them).

If Google asks you to verify the account, or reports it ineligible or suspended, the sign-in or the review fails with that reason; nothing switches to another provider unless you configured a fallback.

Each workspace has one active credential per provider, except where ADR-0026 and ADR-0027 say otherwise. Gemini, OpenRouter and OpenCode Zen store an ordered list of up to 20 API keys (ADR-0026). OpenAI, Anthropic and xAI may keep a consumer subscription and up to 20 API keys together, with a stored default method (ADR-0027). Reviews start on the effective default; when both methods exist, quota or rate limit on the default may switch to the other method on the same provider and model (disclosed in the GitHub summary and run record). Primary, heavy-duty, configured fallbacks, and reviewer-panel bots build the same dual-method chain when both methods are connected. Switching methods does not automatically change the selected model; API and subscription model lists can differ.

## Storage and refresh

Access tokens, refresh tokens, expiry, and provider-specific account data are stored together in a versioned envelope inside the existing vault-encrypted credential column. Dashboard responses expose only the authentication method and normal credential metadata. Individual token values are included in review redaction. No provider CLI or agent tools run in subscription mode.

Tokens are refreshed and persisted under a workspace/provider-specific Postgres advisory lock when less than `SUBSCRIPTION_REFRESH_MARGIN_MS` (10 minutes) remain before the token expires. That margin is longer than pi-ai's own 5-minute refresh window, so pi-ai never receives a token it would try to refresh itself, and the review adapter never refreshes in memory: an in-memory refresh would rotate the provider's refresh token and throw the new one away, which revokes the sign-in. Fresh credentials use a lock-free read. Duplicate refreshes share one promise, and at most two refresh transactions run per process to leave database connections available for ordinary requests. Login, API-key replacement, backup restore, deletion, master-key rotation, and refresh use the same lock, including across web and worker processes.

pi-ai refresh failures are classified from the token endpoint's HTTP status, as Google Antigravity's are: 408, 429, a 5xx or no answer at all may clear on a later attempt, and anything else means the sign-in has to be redone. A retryable refresh failure during a review call fails that call transiently; it never enters the sign-in fallback path. A refused refresh preserves the stored credential, asks the user to sign in again and is recorded on the credential (`sign_in_required_at`); a refresh our own 30-second deadline cut short counts as retryable, and so does a database or lock error while loading the credential. While that flag is set the subscription is skipped without calling the provider, the dashboard shows **Sign in again** on the provider, and a new sign-in clears it. Tokens are resolved again before model calls during a review.

Subscription model calls report token usage but have **$0 incremental API cost**; the subscription itself is billed separately by the provider. The run record also keeps a display-only **API-equivalent** of that usage (`result.pricing.apiEquivalentUsd`, ADR-0024) only when every review call used the subscription. For Google Antigravity the equivalent uses the same model at its own vendor (`claude-*` at Anthropic's price, `gemini-*` at Gemini's); models no API sells, such as `gpt-oss-*`, show none. The equivalent is hidden after a paid method fallback or a configured model fallback. Method-only fallbacks record known `cost_usd` for API-key calls, priced from the workspace's manual price or the catalog, never the repository's `budget.pricing`; configured model fallbacks keep unknown cost (ADR-0008). A switch to API keys that would exceed what is left of the per-review budget is not made. Judge calls keep their own prices.

Credential-inclusive backups passphrase-encrypt the entire subscription envelope. A restored account can require a new login if its refresh token has subsequently rotated or been revoked.

When the primary subscription's refresh is refused, or its stored credential is missing or unreadable, the review treats it as an authentication failure and tries only the bot's explicitly configured, budget-allowed model fallbacks. The PR summary and run record disclose the switch just like a model-call authentication failure. Without an allowed fallback, the run keeps the sign-in error. A retryable refresh failure still fails transiently without entering this fallback path. The failed credential is not refreshed again in that run; any readable stored tokens remain available only for redaction. Each terminal primary credential failure emits one `credential.primary_unavailable` warning with workspace, run, provider and reason, without credential values. The warning carries the token endpoint's HTTP status and OAuth error code when they are known, never a response body and never a token.

The same terminal failure is remembered when a credential crosses the refresh threshold during model construction. Judge setup skips a subscription already unavailable in that run; API-key rosters remain independent.

## Login lifecycle and deployment

Only workspace admins and owners can start, complete, or cancel a login. Attempts are bound to the initiating user and workspace, expire after 15 minutes, and are cancelled when the dialog closes. Device codes and authorization codes are transient; authorization codes are never written to the database. Saving requires an authenticated completion request, so a finished provider login alone cannot write credentials after workspace access has been revoked.

Cancellation aborts a queued credential replacement and rolls back a write before transaction commit. If persistence already committed before cancellation arrived, the cancellation endpoint reports `409 login_already_saved`; remove the saved provider credential to disconnect it.

Pending login conversations live in the web process. A web-process restart requires starting a new login. Multiple web replicas need sticky routing for `/api/workspaces/*/subscriptions/*` for the duration of a login; saved credentials and refresh coordination are shared through Postgres.

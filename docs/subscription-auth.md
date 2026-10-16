# Provider subscription authentication

MergePilot's dashboard offers **API key** and **Subscription** methods for OpenAI, Anthropic, and xAI. Other providers retain their API-key method. Subscription login uses the provider-owned flows and request protocols in `@earendil-works/pi-ai`, the same provider library used by the DeepSeek Harness reference app.

## Connect an account

1. Open **Settings → Provider credentials → Add credential**.
2. Choose **OpenAI**, **Anthropic**, or **xAI**, then select **Subscription** under **Authentication method**.
3. Start sign-in and open the provider's sign-in page:
   - **OpenAI / Codex:** sign in with ChatGPT and enter the displayed device code. Device-code authentication must be enabled in your ChatGPT account settings.
   - **Anthropic / Claude:** sign in with Claude Pro/Max, then paste the authorization code into MergePilot.
   - **xAI / Grok:** sign in with SuperGrok or X Premium and enter the displayed device code.
4. When sign-in succeeds, MergePilot saves the encrypted credentials and closes the dialog. Select a model from the refreshed model list, save your review settings, and use **Test connection** to verify access.

Each workspace has one active credential per provider, except where ADR-0026 and ADR-0027 say otherwise. Gemini, OpenRouter and OpenCode Zen store an ordered list of up to 20 API keys (ADR-0026). OpenAI, Anthropic and xAI may keep a consumer subscription and up to 20 API keys together, with a stored default method (ADR-0027). Reviews start on the effective default; when both methods exist, quota or rate limit on the default may switch to the other method on the same provider and model (disclosed in the GitHub summary and run record). Primary, heavy-duty, configured fallbacks, and reviewer-panel bots build the same dual-method chain when both methods are connected. Switching methods does not automatically change the selected model; API and subscription model lists can differ.

## Storage and refresh

Access tokens, refresh tokens, expiry, and provider-specific account data are stored together in a versioned envelope inside the existing vault-encrypted credential column. Dashboard responses expose only the authentication method and normal credential metadata. Individual token values are included in review redaction. No provider CLI or agent tools run in subscription mode.

Expired tokens are refreshed under a workspace/provider-specific Postgres advisory lock. Fresh credentials use a lock-free read. Duplicate refreshes share one promise, and at most two refresh transactions run per process to leave database connections available for ordinary requests. Login, API-key replacement, backup restore, deletion, and refresh use the same lock, including across web and worker processes. Failed refresh preserves the stored credential and asks the user to sign in again. Tokens are resolved again before model calls during a review.

Subscription model calls report token usage but have **$0 incremental API cost**; the subscription itself is billed separately by the provider. The run record also keeps a display-only **API-equivalent** of that usage (`result.pricing.apiEquivalentUsd`, ADR-0024) only when every review call used the subscription. The equivalent is hidden after a paid method fallback or a configured model fallback. Method-only fallbacks record known `cost_usd` for API-key calls, priced from the workspace's manual price or the catalog, never the repository's `budget.pricing`; configured model fallbacks keep unknown cost (ADR-0008). A switch to API keys that would exceed what is left of the per-review budget is not made. Judge calls keep their own prices.

Credential-inclusive backups passphrase-encrypt the entire subscription envelope. A restored account can require a new login if its refresh token has subsequently rotated or been revoked.

## Login lifecycle and deployment

Only workspace admins and owners can start, complete, or cancel a login. Attempts are bound to the initiating user and workspace, expire after 15 minutes, and are cancelled when the dialog closes. Device codes and authorization codes are transient; authorization codes are never written to the database. Saving requires an authenticated completion request, so a finished provider login alone cannot write credentials after workspace access has been revoked.

Cancellation aborts a queued credential replacement and rolls back a write before transaction commit. If persistence already committed before cancellation arrived, the cancellation endpoint reports `409 login_already_saved`; remove the saved provider credential to disconnect it.

Pending login conversations live in the web process. A web-process restart requires starting a new login. Multiple web replicas need sticky routing for `/api/workspaces/*/subscriptions/*` for the duration of a login; saved credentials and refresh coordination are shared through Postgres.

# ADR-0038: The GitHub Action rejects subscription envelopes

**Date:** 2026-10-21 · **Status:** accepted (decisions log س56) · **Follows:** ADR-0037 (subscription refresh ownership) · **Amends:** ADR-0032 item 12 · **Related:** ADR-0006, ADR-0020

## Context

The dashboard stores a consumer-subscription sign-in (OpenAI/Codex, Claude, Grok, Google Antigravity) as an envelope: the prefix `mergepilot:oauth:v1:` followed by JSON holding the access token, the refresh token and the expiry. The envelope lives in the encrypted vault. Nothing in MergePilot exports it.

The GitHub Action reads provider keys from environment variables through `EnvCredentialStore`. That store passes any non-blank value through unchanged, and `model-builders.ts` builds a subscription adapter whenever the value decodes as an envelope. So an envelope pasted into `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `XAI_API_KEY` is accepted, even though `apps/action/README.md` lists only API-key secrets and the official `claude-code` mode (ADR-0006). Google Antigravity has no API key; its variable `GOOGLE_ANTIGRAVITY_SUBSCRIPTION` can only ever hold an envelope, and ADR-0032 item 12 already called the dashboard its supported path.

Before ADR-0037 the review adapter let pi-ai refresh such a token in memory. In the Action that refresh had nowhere to go: the rotated refresh token was lost when the run ended, and the provider had already invalidated the one in the GitHub secret. When the envelope was a copy of a dashboard sign-in, the refresh also revoked the dashboard's own credential. After ADR-0037 nothing refreshes in the Action, so an envelope works only while its access token is valid (about 8 hours for Claude) and then fails as an authentication error.

## Options

- **A. Reject envelopes up front.** `EnvCredentialStore.resolve` refuses a value that starts with the envelope prefix and names the supported inputs instead. No model call is made.
- **B. Document envelopes as unsupported, change no code.** An envelope still works for one access-token lifetime, then every run fails with a provider 401 that does not say why.
- **C. Accept envelopes while the access token is valid.** Check the expiry up front and fail with a clear message once it has passed. Users would have to re-copy the envelope from the vault several times a day, and the vault offers no way to copy it.

## Decision

Option A.

1. `EnvCredentialStore.resolve` checks only the prefix. It never decodes the envelope, so its tokens are never parsed or handled.
2. It throws `SubscriptionEnvelopeError`, a `MissingCredentialError` with fixed text: the variable name, that the Action does not accept dashboard subscription sign-ins, and the supported alternatives (an API key, or `provider: claude-code` with `CLAUDE_CODE_OAUTH_TOKEN`). The value never appears in the message.
3. `info()` still reports the variable as configured, so the primary path reaches `resolve` and shows this message instead of the generic "no API key is configured".
4. A fallback whose variable holds an envelope is skipped, and the skip reason carries the same fixed text instead of "no API key is configured".
5. `CLAUDE_CODE_OAUTH_TOKEN` is the official CLI's raw token, has no envelope prefix, and is unaffected.

## Consequences

- The check sits at the Action's credential boundary, not in the adapter. If a later pi-ai version or a regression starts refreshing in memory again, the Action still never holds a refresh token it could rotate.
- A run whose primary variable holds an envelope fails at once with a message that says what to use instead. Before, it worked for one token lifetime and then failed with a 401.
- Google Antigravity can no longer run in the Action at all, since its only input is an envelope. It stays available through the GitHub App.
- The GitHub App and the dashboard keep subscriptions unchanged; envelopes from the vault never pass through `EnvCredentialStore`.
- Supporting subscriptions in the Action later would need somewhere to persist rotated tokens. That would be a new decision, not a relaxation of this check.

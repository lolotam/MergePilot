# ADR-0037: Subscription refresh ownership

**Date:** 2026-10-21 · **Status:** accepted · **Amends:** ADR-0020 (dashboard subscription auth)

## Context

Claude reviews fell back to the bot's configured fallback model about eight hours after every sign-in. The cause was two refreshers for the same token.

The credential service refreshed a subscription token only when less than 60 seconds remained before its expiry. pi-ai, the provider library behind the subscription protocol, refreshes its own token five minutes before expiry. So a review call made in the four minutes between those two thresholds handed pi-ai a token inside its own window, and pi-ai refreshed it in memory.

Anthropic rotates refresh tokens: a refresh returns a new refresh token and invalidates the old one. pi-ai's in-memory rotation was thrown away with the request, so the stored credential kept a refresh token the provider had already revoked. The next review asked the token endpoint again, was refused, and fell back. In production on 2026-10-19/20 the sign-in was at 17:26 UTC and the first fallback followed at 01:19:52.

Two problems were left behind. Every call in that window refreshed again from the same stored refresh token, outside the database lock, so one rotation was followed by reuses of an already rotated token. And a refresh the provider refuses could only be repaired by a new sign-in, yet nothing recorded that: every later review asked the token endpoint again, failed, fell back, and the dashboard showed nothing.

## Decision

1. **Only the credential service refreshes.** It refreshes and persists the rotated token under the existing workspace/provider lock, and it does so when less than `SUBSCRIPTION_REFRESH_MARGIN_MS` (10 minutes) remain before expiry. The margin is longer than pi-ai's own 5-minute window, so pi-ai never receives a token it would try to refresh itself.
2. **The review adapter never refreshes in memory.** `SubscriptionAdapter` hands pi-ai a credential store whose `modify` returns the credential unchanged. An in-memory refresh would rotate the provider's refresh token and discard the new one, which revokes the sign-in.
3. **A refused refresh is persisted and skipped.** Migration `0016_credential_sign_in_required.sql` adds the nullable `provider_credentials.sign_in_required_at`. When the token endpoint refuses a refresh (the reason `sign-in`), the service writes that timestamp in the same transaction instead of throwing inside it, and the caller sees the failure only after the flag has committed. While the flag is set the subscription is skipped without calling the provider, so the review goes straight to the configured fallback with the existing disclosure. A new sign-in replaces the credential row and clears the flag.
4. **Only a refused sign-in is remembered.** A refresh failure the provider may answer differently later (HTTP 408, 429, a 5xx, or no answer at all) stays retryable: nothing is written, and the next resolve asks the provider again.
5. **The cause is logged without the body.** The `credential.primary_unavailable` warning carries the token endpoint's HTTP status and the OAuth error code when they are known, never a response body and never a token.

## Consequences

- One migration (`0016_credential_sign_in_required.sql`) and one nullable column; existing rows are unchanged.
- A misclassified transient failure would need a new sign-in to repair. Only 408, 429, 5xx and no answer are treated as retryable; anything else means the sign-in is gone.
- The dashboard shows **Sign in again** on the provider while the flag is set, so a refused refresh is visible instead of silent.
- A subscription envelope provided through the environment (the GitHub Action) is no longer refreshed in memory. An expired one fails as an authentication error rather than being renewed on the fly, because the action has nowhere to persist a rotated refresh token.

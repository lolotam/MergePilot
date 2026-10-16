# ADR-0020: Dashboard API-Key and Consumer-Subscription Authentication

- **Status:** Accepted (owner request, 2026-10-13). Amended by ADR-0032: a subscription-only Google Antigravity provider whose protocol is MergePilot's own code, not pi-ai's.
- **Related:** ADR-0002, ADR-0003, ADR-0004, ADR-0006, ADR-0007, ADR-0016, ADR-0018.
- **Supersedes:** the API-only/no-pi-ai restrictions in ADR-0002/0003/0004 and the dashboard subscription restrictions in ADR-0006/0007. The official Claude Code Action mode remains available.

## Decision

The dashboard offers API-key and consumer-subscription methods for OpenAI/Codex, Anthropic/Claude, and xAI/Grok. The owner chose dashboard login rather than running an already-authenticated CLI, using DeepSeek Harness as the reference.

Provider-owned OAuth and model protocols come from `@earendil-works/pi-ai`. Headless server login uses Codex/Grok device codes and Claude copy-code authorization. Other providers retain their existing API-key methods.

Each workspace/provider retains one active credential, except ADR-0027 dual-method providers (`anthropic`, `openai`, `xai`) which may store a subscription parent and API-key slots together. A versioned subscription envelope stores access, refresh, expiry and account-specific data inside the existing vault-encrypted column. For non-dual providers, replacing a method replaces that credential.

Login attempts are bound to the initiating user/workspace, cancellable and limited to 15 minutes. An authenticated admin completion request persists the credentials. Attempts are process-local, so multiple web replicas require sticky routing until login completes.

Credential writes, restores, deletion and refresh share a Postgres advisory lock per workspace/provider. Refresh failures preserve the old encrypted credential. Individual tokens are redacted from prompts, output and errors.

Model discovery, connection tests, primary/heavy/fallback choices and reviewer-panel models use the provider's active method. Subscription requests report token usage with zero incremental API cost; the subscription itself is billed separately. Since ADR-0024 the run also carries a display-only API-equivalent of that usage, never counted as spend. Paid API fallback costs retain the existing unknown-after-fallback behavior. Credential-inclusive backups seal the complete envelope with the backup passphrase.

## Consequences

- Existing provider identifiers and review configuration remain usable; switching methods can require selecting a different model.
- MergePilot now stores and refreshes consumer-subscription tokens, in addition to API keys.
- The pi-ai version is pinned and its protocol/behavior changes must be reviewed before upgrades.
- Provider login and account access still depend on the upstream provider. Connection testing verifies actual access.

Operational details and dashboard steps live in [subscription authentication](../subscription-auth.md).

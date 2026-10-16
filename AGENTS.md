# MergePilot agent instructions

MergePilot reviews pull requests through a shared TypeScript engine, a GitHub Action, and a GitHub App with a web dashboard and review workers.

## Before changing code

- Inspect `git status` and preserve existing user changes.
- For review-engine or package-boundary changes, read `docs/architecture.md` and the relevant files in `docs/adr/`. Product history lives in `docs/prd/` and `docs/decisions.ar.md`; use current code and the current task when older plans differ from implemented behavior.
- For provider authentication, token refresh, or subscription pricing changes, read `docs/subscription-auth.md`.
- Treat `reference/` and external reference repositories as read-only source material. When copying MIT code, retain its notice and update `THIRD_PARTY_NOTICES.md`.

## Boundaries and conventions

- `packages/engine` owns review logic, provider adapters, model protocols, config validation, and secret redaction. It does not import from `apps/`.
- `packages/github` owns GitHub reads, publishing, and review rendering. `apps/action` and `apps/app` supply credentials and call the shared engine.
- `apps/app/src/api/contract*.ts` defines dashboard REST schemas consumed by `apps/web`. Update producers and consumers together.
- Use TypeScript ESM and `.js` extensions in relative imports. Keep user-visible text in the Arabic/English dictionaries under `apps/web/src/i18n/`.
- Match the existing components and styling for dashboard changes. Keep code and identifiers in English; respect the user's requested conversation language.

## Review and credential invariants

- Never execute code from a PR or install the reviewed repository's dependencies.
- Keep credentials out of logs, error bodies, prompts, and dashboard responses. Redact individual access and refresh tokens, not only serialized credential values.
- Keep custom provider URLs in trusted workspace settings or Action inputs; repository config cannot redirect credentials. Preserve the custom URL SSRF checks.
- Surface provider failures as `LlmFailure`. Model fallback must be explicitly configured and disclosed.
- The dashboard supports API keys and consumer subscriptions for OpenAI/Codex, Anthropic/Claude, and xAI/Grok. Each workspace has one active credential per provider, except gemini, openrouter and opencode-zen (ADR-0026 multi-key list) and anthropic, openai and xai which may keep a subscription and up to 20 API keys together with a stored default method (ADR-0027).
- Delegate OAuth protocol details to the pi-ai provider library. Use device codes for Codex/Grok and copy-code login for Claude on the web server.
- Store subscription envelopes through the existing vault. Login, replacement, restore, disconnect, master-key rotation, and token refresh must share the workspace/provider credential lock across web and worker processes.
- Subscription calls retain token usage and report zero incremental API cost; they may carry a display-only API-equivalent figure (`result.pricing.apiEquivalentUsd`, ADR-0024) that never enters `cost_usd`, the budget or the GitHub summary. Judge calls and paid API fallbacks keep their own accounting rules.

## Validation and delivery

- Use the pnpm version declared in `package.json`. Keep dependency installation and build artifacts on `E:\Dev` in this Windows environment.
- Run `pnpm typecheck` before tests in a fresh worktree: project references emit the workspace-package `dist` files that test imports resolve. Before delivery, run `pnpm lint`, relevant tests with `pnpm exec vitest run <paths>`, and `pnpm build`.
- `pnpm check` is the complete typecheck/lint/unit-test/build gate. Database integration checks use `pnpm test:integration`; the Action bundle uses `pnpm bundle`.
- Authentication changes need coverage for admin authorization, user/workspace isolation, cancellation/expiry, encrypted persistence, concurrent refresh, and token redaction. Provider changes need request-protocol and failure-classification coverage.
- Update affected usage documentation. Report the commands actually run and any remaining verification limits.
- Commit, push, merge, or deploy only when the user requests it.
- Production releases follow ADR-0025 (`.github/workflows/release.yml`, `scripts/release/`). It deploys only while the owner keeps the repository variable `MERGEPILOT_AUTO_RELEASE` set to `enabled`; until then the workflow is a dry run and deploys still need the owner's explicit approval. Never set that variable, the Dokploy credentials, branch protections or the `production` branch yourself.

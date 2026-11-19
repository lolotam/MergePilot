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
- Match the existing components and styling for dashboard changes. Keep code and identifiers in English.

## Conversation language

- Reply to the owner in simple Egyptian Arabic only, even when the owner writes in English. This covers every reply: status lines, progress updates, questions and final summaries. Switch to English only when the owner asks for an English reply in that message. Reply to anyone else (for example a contributor commenting on a PR) in the language they wrote in.
- Code, identifiers, commit messages, PR titles and descriptions, and English documentation stay in English. Keep file paths, commands, model names and error messages verbatim inside the Arabic text.

## Delivery tiers (Light / Medium / Heavy Implementation Pipeline)

Canonical owner rule: [docs/decisions.ar.md, س68](docs/decisions.ar.md#س68-مستويات-التسليم-light--medium--heavy). Apply it to every new task, side tasks and follow-up issues included. It replaces the routine merge and review wait only where a tier below says so. Every other project gate stays.

1. **Tier card before every new task.** Send Waleed an AskUserQuestion card in Arabic with three options, the recommended one first and marked «(المقترح)»: the tier, the recommendation, a one-line reason, and an exception option (for example an extra review or step on top). Do not start before the answer. Put the tier and the exception in the brief and in the PR body. Fix rounds inside a running task need no new card.
2. **LIGHT**: docs, specs, plans, ADRs, roadmap/status files, i18n, and small CSS/UI changes up to about 150 lines. Never money, permissions/auth, DB/migrations, API, or a new dependency. The manager or the cheapest implementer does it. The PR merges as soon as CI is green on the exact head, without waiting for review bots. Waleed's instruction is the approval (2026-11-19). MergePilot has no staging: a Light change ships with the next release, and a docs-only merge is skipped by the release gate as `no-image` (ADR-0025).
3. **MEDIUM**: at most 3 review rounds. Local review (`/code-review`) plus the project's review bots (CodeRabbit and the MergePilot panel; skip a bot stuck for more than 1 hour and say so in the merge report). CI green on the exact head. After round 3, P2/P3 findings become issues; P0/P1 block. Merging to main releases through the ADR-0025 gate (this project's replacement for a daily staging batch).
4. **HEAVY** (migrations, money, permissions/auth, security, long background jobs): Claude Fable 5.2 (medium) writes the implementation plan and Codex Astra 6.2 (medium) debates it for ONE round before implementation. Full review and CI with the round cap above. A PR with a migration, money or permissions/auth merges ONLY after Waleed's card approval, after all gates. Other Heavy work: the manager merges after all gates. Take a DB snapshot with a receipt before a migration reaches production.
5. **Implementer fallback, fixed order.** Light: manager or GLM, then Claude Sonnet. Medium and Heavy: Kimi, MiniMax, GLM, Grok, then Claude Sonnet (Heavy on Sonnet at high effort). After 2 failures or an exhausted quota, move to the next lane without asking. Use only the lanes this project has and keep the order.
6. **Plan summary after every merge** in 3 parts: «ما تم» (main tasks done with PR numbers), «الباقي» (each remaining main task with its sub-tasks and status), «التوصية». Fold side tasks under their main task and keep any roadmap/status file in sync. End every report with these headings exactly: «المطلوب منك»، «الخطوة الجاية اللي أنصح بيها»، «ملاحظة» (write «مفيش» if none).

What the tiers do not change: production, servers, secrets, Dokploy credentials, branch protections, `MERGEPILOT_AUTO_RELEASE` and release-hold decisions stay Waleed's. A Light change that touches an image-building path still goes through the ADR-0025 release gate. Migrations, new cost/provider/resource configuration and unresolved HOLD cases stay separate owner decisions, even for a task that looks Light.

## Review and credential invariants

- Never execute code from a PR or install the reviewed repository's dependencies.
- Keep credentials out of logs, error bodies, prompts, and dashboard responses. Redact individual access and refresh tokens, not only serialized credential values.
- Keep custom provider URLs in trusted workspace settings or Action inputs; repository config cannot redirect credentials. Preserve the custom URL SSRF checks.
- Surface provider failures as `LlmFailure`. Model fallback must be explicitly configured and disclosed.
- The dashboard supports API keys and consumer subscriptions for OpenAI/Codex, Anthropic/Claude, and xAI/Grok, and a subscription-only Google Antigravity provider (`google-antigravity`, ADR-0032) that has no API keys and is offered only when `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_ID` and `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_SECRET` are configured. `gemini` stays API-key only. Each workspace has one active credential per provider, except gemini, openrouter and opencode-zen (ADR-0026 multi-key list) and anthropic, openai and xai which may keep a subscription and up to 20 API keys together with a stored default method (ADR-0027).
- Delegate OAuth protocol details to the pi-ai provider library. Use device codes for Codex/Grok and copy-code login for Claude on the web server. Exception (ADR-0032): pi-ai has no Google provider, so Google Antigravity's OAuth and Cloud Code Assist protocol live in `packages/engine/src/providers/subscription/antigravity/`, with a paste-the-address login behind a required Terms-of-Service acknowledgement. Never commit its client values.
- Store subscription envelopes through the existing vault. Login, replacement, restore, disconnect, master-key rotation, and token refresh must share the workspace/provider credential lock across web and worker processes.
- Subscription calls retain token usage and report zero incremental API cost; they may carry a display-only API-equivalent figure (`result.pricing.apiEquivalentUsd`, ADR-0024) only when every review call stayed on the subscription. Dual-method providers (ADR-0027) may fall back between subscription and API keys on quota or rate limit; that switch is disclosed, API-key calls count toward the monthly budget, and method-only fallbacks record known `cost_usd`. Judge calls and configured model fallbacks keep their own accounting rules.

## Validation and delivery

- Use the pnpm version declared in `package.json`. Keep dependency installation and build artifacts on `E:\Dev` in this Windows environment.
- Run `pnpm typecheck` before tests in a fresh worktree: project references emit the workspace-package `dist` files that test imports resolve. Before delivery, run `pnpm lint`, relevant tests with `pnpm exec vitest run <paths>`, and `pnpm build`.
- `pnpm check` is the complete typecheck/lint/unit-test/build gate. Database integration checks use `pnpm test:integration`; the Action bundle uses `pnpm bundle`.
- Authentication changes need coverage for admin authorization, user/workspace isolation, cancellation/expiry, encrypted persistence, concurrent refresh, and token redaction. Provider changes need request-protocol and failure-classification coverage.
- Update affected usage documentation. Report the commands actually run and any remaining verification limits.
- Commit, push, merge, or deploy only when the user requests it.
- Production releases follow ADR-0025 (`.github/workflows/release.yml`, `scripts/release/`). It deploys only while the owner keeps the repository variable `MERGEPILOT_AUTO_RELEASE` set to `enabled`; until then the workflow is a dry run and deploys still need the owner's explicit approval. Never set that variable, the Dokploy credentials, branch protections or the `production` branch yourself.

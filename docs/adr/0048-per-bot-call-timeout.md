# ADR-0048: Optional per-bot call timeout override (`callTimeoutMs`)

- **Date:** 2026-10-30
- **Status:** Accepted; implemented and verified locally on 2026-10-30. Release, production migration and activation are pending. Nothing has been released or activated.

## Context

ADR-0013 bounded every model call with a per-call timeout (`review.callTimeoutMs`, default 300,000 ms) and the review itself with a soft deadline (`review.totalTimeoutMs`, default 1,200,000 ms). The repository's effective value applied to every bot.

The reviewer panel (ADR-0017) runs the main bot (slot 1) and the extra bots (slots 2–5) as their own reviews, each with its own provider, model and fallback chain, but every bot inherited that same call timeout.

The owner asked for an optional per-bot override, starting with 600,000 ms for Waleed_Bot only.

## Decision

### 1. The override is optional, nullable and per bot

- `callTimeoutMs?: number | null | undefined` on the workspace settings (main bot, slot 1) and on each reviewer bot (slots 2–5).
- Integer milliseconds, bounded to 1,000–1,200,000 (`CALL_TIMEOUT_MIN_MS`, `CALL_TIMEOUT_MAX_MS`); the API validates the bound.
- `null` means inherit: the repository effective `review.callTimeoutMs` (`.mergepilot.yml`), else the engine default 300,000.
- An omitted write keeps the stored value; an explicit numeric write stores the override; normalized reads return `null` when unset.

### 2. Precedence and independence

- A numeric override wins over the repository effective `review.callTimeoutMs` for that bot only; without one, the repository value or the engine default applies.
- No special-case bot names, providers or models; no change to defaults, budgets, prompts, fallbacks or credentials.
- The main bot's override never leaks to the extra bots, and extra bots never inherit each other's overrides.

### 3. Storage, API, backup and migration

- `PUT /settings` and `PUT /bots/:slot` accept `callTimeoutMs`; left out keeps the stored value, explicit `null` resets to inherit, a number writes the override.
- Both stores (memory and Postgres) read and write the column the same way: normalized reads expose `null` when unset; writes include the column only when the incoming value is not `undefined` (null is a real write).
- Migration `0018_bot_call_timeout.sql` adds the nullable `call_timeout_ms` column to `workspace_settings` and `reviewer_bots` with a CHECK of `call_timeout_ms IS NULL OR (call_timeout_ms >= 1000 AND call_timeout_ms <= 1200000)`; the column is nullable without a default, so a new row is `null` (inherit) as before.
- Backups retain main and extra-bot overrides. A restored section from an older backup without the timeout field resets its override to inheritance; omitting the entire settings section still preserves the target's existing settings. Invalid timeout values are rejected before any restore writes.
- The existing main and extra-bot forms display seconds and send integer milliseconds; an empty saved field sends `null`. Field omission on unrelated saves preserves the stored override. The dashboard keeps existing permissions and conflict handling.

### 4. Execution, fallback and the deadline

- The override is passed to `effectiveConfigFor(..., callTimeoutMs)` and joins the parsed review config, so the engine applies it to every call of the bot's chain (`withCallTimeout` on the primary and on each fallback model).
- A `TIMEOUT` keeps its meaning: an `LlmFailure` with code `TIMEOUT`, a fallback trigger, disclosed.
- `review.totalTimeoutMs` stays the soft batch-start deadline: once reached, no new batch starts and the verification pass is skipped; in-flight calls are bounded by their own call timeout and are not aborted by the deadline. Increasing the per-call timeout can increase the completion time and the chance that the verification pass is skipped.

### 5. Config identity

- `configHashOf` gains the explicit override in its structured identity (`{ base, maxFindings?, skill?, perReviewUsd?, callTimeoutMs?, panelTimeouts? }`). The consensus-only panel entry is a slot-sorted, serialized list of explicit overrides; it affects identity, not any bot's effective timeout.
- Omitted or null means the legacy hash (the key is absent); an explicit number — even equal to the default — is its own entry, so it never hashes like the inherited value and never collides with repository text.
- Separate mode is per bot; consensus mode includes the override of every active bot (slot-sorted, like the skill key, ADR-0034). When no bot has an explicit override, the markers keep the old hashes.
- Identity changes control which files are reviewed. The existing publication guard still suppresses another completed review for the same head and bot, independently of config identity; an explicitly requested repeat (`force`) can publish its new marker on that head.

## Consequences

- A per-bot timeout without per-bot prompts: the override only changes how long a bot may take; the fallback chain, the cancellation handling and the disclosure of a `TIMEOUT` are unchanged.
- Provider credentials, billing and pricing are unaffected.

## Rollout and rollback

- Activation is owner-approved: after the release and migration are separately approved and the stored value is confirmed to be 600000 for Waleed_Bot only, the override goes live.
- Measurement: 48 hours, extend if the sample is small; target timeout-triggered fallback ≤ 5%, Opus completion ≥ 95%; track other fallback reasons, latency and incomplete reviews and verifier skips; keep all other review settings fixed. No claim that increasing the timeout is proven to improve precision.
- Rollback experiment: reset the field to inherit (`null`) for the affected bot; no data deletion.

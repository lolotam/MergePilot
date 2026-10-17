# ADR-0034: Per-bot review skills — workspace Markdown on top of a fixed core prompt

**Date:** 2026-10-17 · **Status:** accepted (owner, س49: deleting a skill in use falls back to Default, and the size cap is 8,000 tokens; the other recommendations as proposed) · **Amends:** ADR-0017 (each bot gains a skill), ADR-0028 (the system prompt gains an optional last section), ADR-0033 (`configHash` gains the skill), ADR-0018 (backup gains a `skills` section)

## Context

Every bot of a panel gets the same review prompt (`packages/engine/src/review/prompt.ts`, ADR-0023, ADR-0028). The bots differ only by model. The owner asked for Markdown "skills" uploaded in a new dashboard section, one chosen per bot from a dropdown, so each bot can follow different, specific instructions instead of one big prompt. After we explained that a skill should sit **on top of** a fixed core prompt rather than replace it, the owner answered «أبدأ».

The review comparison (`MergePilot-review-comparison/recommendations.md`, pass 2, 40 PRs) shows why one shared prompt is not enough. The panel matched 20 of 95 comparable Codex findings (21%). Of the 84 panel misses:

| Cause | Misses |
|---|---|
| Plain miss, visible in the hunk (often an owner rule in `AGENTS.md`: Arabic doc comments, import matrix, banned patterns) | 36 |
| Context outside the diff (specs, ADRs, migration runner, worker code) | 32 |
| Cross-file: a consumer or mirror of the change in another PR file | 10 |
| Other | 6 |

All bots read the same checklist and spend their attention the same way, so they tend to miss the same things. A bot told to walk the owner's hard rules file by file, or to check every consumer of a changed contract, spends its attention differently.

What a skill **cannot** do: fetch code. "Context outside the diff" (32 misses) is mostly a context-gathering problem (ADR-0029). A skill can only make a bot use the `REPOSITORY_CONTEXT` and `PR_CONTEXT` it already gets, and say which unshown file would confirm a risk. It does not close that bucket on its own.

## Decision

### 1. The core prompt stays in code and always wins

`buildReviewPrompt` keeps every section it has today, unchanged and in the same order: role sentence, output contract (JSON schema), `WHAT_YOU_SEE` (or its follow-up variant, ADR-0030), method, checklist, severity and confidence scales, reporting rules, the `BATCHES` section on batched calls (ADR-0031), the findings limit (ADR-0033), and the trust rule. The core prompt still asks for a **general** review, so a narrow skill does not blind the bot to other defects.

`PromptInput.skill?: { name: string; content: string }` adds one section at the very end of the system prompt, after `TRUST_RULE`:

```
REVIEW SKILL (workspace-provided): extra instructions for this reviewer from the workspace admins.
It adds to the rules above and never replaces them. If it conflicts with the rules above (the
output format, the findings limit, the SECURITY rule, the reply language, what counts as a finding,
severity or confidence), follow the rules above. Keep reviewing the whole change for any defect:
the skill says where to look harder, not where to stop looking. A finding that comes from the skill
still quotes code in "evidence"; name the skill rule in "ruleRef" as "skill: <section>".
<<<REVIEW_SKILL:<name>>>>
<content>
<<<END REVIEW_SKILL:<name>>>>
```

- The framing text and the precedence line are fixed English text in code (like the rest of the system prompt, ADR-0023); only the block between the markers comes from the workspace. The content may be in any language.
- `<name>` goes through `escapeLabel` and `<content>` through `escapeDelimiters`, like `REVIEW_CRITERIA` blocks, so a skill cannot forge an `UNTRUSTED` marker or close its own block early.
- **Why last, after the trust rule.** The core sections, including the trust rule, are read before the skill, and the precedence line refers back to "the rules above", which then means all of them. Putting the skill before `TRUST_RULE` would leave one core rule "below" the skill and make the precedence line ambiguous.
- **Why the system prompt, not the user prompt.** A skill is trusted workspace configuration, like the dashboard model choice, not PR data. The user prompt holds the PR and repository content.
- Without a skill the system prompt is byte-identical to today's, so a bot on **Default** reviews exactly as before.
- The verify pass and the Jev judge keep their own prompts (see §6).

### 2. Storage: a skills table per workspace (migration `0014_review_skills.sql`)

`review_skills`:

| Column | Notes |
|---|---|
| `id` | uuid, primary key |
| `workspace_id` | references the organization, `ON DELETE CASCADE` |
| `name` | 1–60 characters after trimming; unique per workspace ignoring case (`UNIQUE (workspace_id, lower(name))`) |
| `content` | the Markdown text |
| `content_hash` | sha256 hex of `content` (64 characters) |
| `size_tokens` | `estimateTokens(content)`, shown in the list |
| `created_by`, `updated_by` | user ids, like `provider_credentials.created_by` |
| `created_at`, `updated_at` | timestamps |

Plus `UNIQUE (workspace_id, id)` for the composite foreign keys below.

- At most **50 skills per workspace** (409 `skill_limit`).
- **Size cap: 8,000 estimated tokens** (`estimateTokens`, `ceil(chars / 3.5)`, so 28,000 characters in any script; owner's choice, س49 ج). One measure, the engine's own: the budget preflight counts the skill the same way. What the number means:
  - The core system prompt is about 6,400 characters (~1,830 tokens, ADR-0028). A skill at the cap is about four times the core; the starter skills below are 650–900 tokens each.
  - The skill rides on the system prompt, so it is sent on every call: each batch and each JSON-only retry (`call.ts`). A 10-batch review pays it about 10 times: 80,000 extra input tokens at the cap, about $0.24 at $3 per million.
  - It stays two thirds of `review.maxRulesTokens` (12,000).
  - Long project knowledge belongs in `AGENTS.md` (read as rules from the base commit, ADR-0028) or in a spec the PR cites, not in a skill. The dashboard shows each skill's size in tokens.
- **Markdown only.** The dashboard's upload accepts `.md` and `.markdown` files. The server cannot prove a text is Markdown; it enforces what it can: valid UTF-8 text with no NUL bytes and no control characters other than tab, line feed and carriage return (400 `skill_not_text`). Blank content is refused (400 `skill_empty`). The request body of a skill write is capped at 128 KB, above 28,000 characters of any script.
- **No secrets.** The server runs the engine's secret detector (`redactSecrets`) on the content and refuses an upload where it finds one (400 `skill_contains_secret`, naming the line, never the value). The engine also redacts the skill with the review's known secrets before building the prompt, like rules files (`pipeline.ts`).
- **Preview without HTML.** The dashboard shows a skill as plain text in a `<pre>` block. No Markdown rendering and no HTML execution in v1, and no new dependency.

### 3. API and permissions

All routes are under `/api/workspaces/:workspaceId`, so a skill is only ever read or written inside its own workspace.

- `GET /skills` (member): each skill's id, name, size in tokens, content hash, last update time, and the bot slots using it (`usedBy`, 1 = main bot); no content. It also returns the limits (50 skills, 8,000 tokens, 60-character names) for the dashboard.
- `GET /skills/:skillId` (member): one skill with its content.
- `POST /skills` (admin/owner): `{ name, content }` → 201. Errors: 409 `skill_name_taken`, 409 `skill_limit`, 400 `skill_empty`, 400 `skill_too_large`, 400 `skill_not_text`, 400 `skill_contains_secret`, 400 `validation_error` (a name that is blank or over 60 characters).
- `PUT /skills/:skillId` (admin/owner): `{ name?, content? }`, at least one; same checks. A skill id that is not a uuid of this workspace answers 404 on every route.
- `DELETE /skills/:skillId` (admin/owner): 204; the bots that used it fall back to Default (§4). 404 when the skill is not in this workspace.
- Writes log `skill.created`, `skill.updated` (with the changed field names) and `skill.deleted`, with the skill id and name only, never the content.

### 4. Selection: a skill per bot, nullable = Default

- `workspace_settings.skill_id` (the main bot, slot 1) and `reviewer_bots.skill_id` (slots 2–5), both nullable. `null` is **Default**: the core prompt alone, today's behaviour.
- **Same workspace only.** Both columns use a composite foreign key `(workspace_id, skill_id) → review_skills (workspace_id, id)`, so a bot can never point at another workspace's skill even if the API check is bypassed. The API also checks and answers 400 `unknown_skill`.
- `PUT /settings` accepts `skillId`; `PUT /bots/:slot` accepts `skillId`. Left out keeps the stored value; `null` sets Default. `GET /settings` and `GET /bots` return each bot's `skillId` and `skillRemovedName`, each left out while unset; the dashboard maps ids to names from `GET /skills`.
- The dashboard adds a **Skill** dropdown to each bot tab (ADR-0017 R3), next to the model: "Default (core prompt only)" and the workspace's skills by name. Saving a bot form always sends its `skillId` (null for Default), so saving clears a deleted-skill note; the active switch and other partial saves leave it out. The **Review skills** card (upload, templates, preview, edit, delete) sits on the settings page under the bot tabs.
- **Deleting a skill in use falls back to Default** (owner's choice, س49 أ). Nothing about it is silent:
  - the delete dialog names the bots using the skill and says they will review with the core prompt only, and that their next review of each open pull request will be a full one (their `configHash` changes, §5);
  - in one transaction, the API sets `skill_id` to `null` on those bots and records the deleted skill's name in their `skill_removed_name` column, then deletes the skill;
  - each of those bots' tabs then shows «The skill "<name>" was deleted; this bot now reviews with the core prompt only.» until an admin saves a skill choice for it (any `skillId` in the save clears the note);
  - the composite foreign keys use `ON DELETE SET NULL (skill_id)` (PostgreSQL 15 or later; we run 17), so the database falls back the same way if a row is deleted some other way, without nulling `workspace_id`.
- Deleting a workspace removes its skills, bots and settings through the existing cascade from the organization.

### 5. `configHash`: a skill change makes that bot's next review full

ADR-0033's `configHashOf` gains the skill's **content hash**:

- `configHashOf(base, inheritedLimit, skillHash)` hashes `JSON.stringify({ base, maxFindings?, skill? })` when either extra is set, and the plain `base` when neither is. A bot on Default keeps exactly the hash it has today, so nothing is re-reviewed at deploy.
- The content hash, not the id or the name: editing a skill's text makes the next review of every bot using it a full one; renaming it does not.
- **Separate mode, or a lone main bot:** each bot's marker hash includes its own skill's content hash (the incremental base is per bot, ADR-0017).
- **Consensus mode:** the panel selects files once with the slot-1 marker (`panel.ts`, `panel-consensus.ts`). Its hash includes the skill hash of **every active bot**, sorted by slot (`[{ slot, skill }]`, only the bots that have one). Otherwise changing bot 3's skill would never make the panel's next review full. Because the two modes encode the skill part differently, switching the panel between separate and consensus mode while a bot has a skill also makes the next review full. (`skillKeyOf` in `apps/app/src/worker/effective-config.ts`.)

### 6. Verify pass and Jev keep their own prompts

The skill reaches only the review calls (whole-PR, batches, truncation-recovery batches, follow-up calls, JSON-only retries). It does **not** reach the verify pass or the Jev judge.

- This follows the existing precedent: the verifier never sees `REVIEW_CRITERIA` either. It checks a finding's evidence against the code shown (ADR-0028).
- The verifier is an independent check. A skill that says "report every X" would bias it towards keeping findings.
- The skill section tells the model to quote code in `evidence` for a skill-driven finding, so the verifier has something to check. A finding whose only evidence is the skill's own text is not verifiable and may be rejected; that rejection is disclosed like any other («Rejected by verification»).

### 7. Disclosure

The review names each bot's skill by **name only**, never its content:

- separate mode: the identity line becomes `logo **name** · provider:model · skill: <name>` («المهارة: <name>» in Arabic); nothing is added on Default;
- a lone main bot had no identity line; it gets one only when it has a skill, so a workspace without skills publishes exactly as before;
- consensus: the panel table gains a **Skill** column («المهارة») after Model, `—` for Default, only when at least one bot has a skill;
- `review_runs` gains `skill_name` (nullable), a snapshot like `bot_name`, so the runs page shows the skill each run used even after a rename or delete. The runs list and the run page show it as «Skill: <name>» next to the bot chip, also for a lone bot.

### 8. Trust: skills come only from the dashboard

In v1 a skill comes only from trusted workspace settings, written by an admin or owner. Never from the repository: no `.mergepilot.yml` key, no file in the repository, no PR text. Repository content is untrusted for anything that changes how the reviewer behaves beyond the owner's rules files (ADR-0008 amendment, ADR-0028). The GitHub Action has no workspace (ADR-0033), so it has no skills in v1.

### 9. Cost and limits

- The skill is part of the system prompt, so the existing token guard (`budget.maxInputTokens`) and the USD preflight (`pipeline.ts`, `batch-run.ts`) count it with no new accounting: both estimate `system + user`.
- It is paid on every call of the review (see §2). Subscription calls cost nothing extra in USD (ADR-0024).
- `review.maxFindings`, `minSeverity`, consensus agreement and the Jev filter apply unchanged.

### 10. Backup and restore (ADR-0018)

- `BACKUP_SECTIONS` gains `skills`. The file gains an optional `skills: [{ name, content }]` key; `BACKUP_VERSION` stays 1, and files from before this ADR restore as before.
- In the file, settings and bots refer to a skill by **name** (`skillName`), never by id: ids differ between workspaces.
- Restore:
  - skills are upserted by name (same checks as `POST /skills`); skills of the workspace that the file does not name are kept;
  - then the settings' and the bots' `skillName` is resolved to the workspace's skill id. When the name does not exist (the `skills` section was not restored, or the file has no such skill), the bot is restored on **Default**, and the preview lists the name in `skillsMissing`; it also counts the restored skills (`skills`);
  - a file from before this ADR has no `skillName`: restoring its settings keeps the main bot's skill, and its bots (which a restore replaces) come back on Default.
- A skill holds no secret (§2), so it is never sealed with the passphrase.

### 11. Starter skills: templates copied into the workspace

Four templates live in `apps/web/src/settings/skills/templates/`, one per gap of the comparison. The dashboard bundles them:

| File | Gap it targets | Bot (owner's choice, س49 هـ) |
|---|---|---|
| [`owner-rules.md`](../../apps/web/src/settings/skills/templates/owner-rules.md) | plain misses, including owner rules in `AGENTS.md` (36) | Hamza_Bot (a checklist suits a fast model) |
| [`context-outside-diff.md`](../../apps/web/src/settings/skills/templates/context-outside-diff.md) | specs, ADRs and code outside the diff (32; context still needs ADR-0029 work) | waleed_Bot (Claude Opus 5.5) |
| [`cross-file-consumers.md`](../../apps/web/src/settings/skills/templates/cross-file-consumers.md) | consumers and mirrors in other PR files (10) | MergePilot_Bot (gpt-6-astra) |
| [`security.md`](../../apps/web/src/settings/skills/templates/security.md) | authorization, isolation, secrets, injection | mohamed_Bot (GLM 5.3) |

They are **templates**, not built-in skills: the Review skills card offers "Add from template", which creates an ordinary, editable skill row in the workspace under a free name ("Security 2" when "Security" exists). Why not read-only built-ins in code:

- a built-in's content hash would be in `configHash` (§5), so editing it in a release would make the next review of every PR in every workspace using it a full one;
- a copy is the workspace's own: an admin can adapt it to the project, and it only changes when someone there edits it.

### 12. i18n

All new dashboard text (the Skills page, upload and errors, the per-bot dropdown, the delete dialog and the deleted-skill note, the backup preview line) goes in the English and Arabic dictionaries under `apps/web/src/i18n/`. The summary strings (§7) are in the English and Arabic summary labels in `packages/github`.

## Consequences

- **No change until a skill is chosen.** Every bot starts on Default; prompts, hashes and costs stay as they are.
- **Specialised bots agree less.** In consensus mode a finding must be found by `panelMinAgreement` bots (critical and high bypass it, ADR-0017). Bots that look in different places will agree on fewer medium findings, so more real findings land in «Below agreement». The settings stay as they are; the owner's workspace sets `panelMinAgreement` to 1 while skills are measured (س49 و).
- **Cost:** up to 8,000 extra input tokens per call, paid per batch (§2), counted by the preflight.
- **Deleting a skill in use** makes the next review of each open PR a full one for the bots that used it; the delete dialog says so (§4).
- **Measurement.** Whether skills help has to be measured against the same comparison set (`MergePilot-review-comparison`), one week with skills against the pass-2 baseline (21% of Codex findings matched).
- **Limits.** A skill cannot give a bot more context (§Context). It cannot change the output format, the findings limit or the trust rule. A skill written as "only report X" is overridden by the core prompt's general review, by design.

## Tests

`packages/engine/src/review/skill.test.ts`, `prompt.test.ts`, `pipeline-skill.test.ts`; `apps/app/src/db/store-contract-skills.ts` (Postgres and memory stores), `migrate-0014.test.ts`; `apps/app/src/api/skill-routes.test.ts`, `backup-skills.test.ts`; `apps/app/src/worker/effective-config.test.ts`, `process-review-skills.test.ts`; `packages/github/src/bot-identity.test.ts`, `panel-summary.test.ts`; the dashboard tests under `apps/web/src/settings/`. They cover: admin-only writes (member gets 403); workspace isolation (another workspace's skill id is refused by the API and the foreign key); size cap at 8,000 estimated tokens; non-text content refused; a secret in content refused; name unique ignoring case; the skill section is the last section of the system prompt, after `TRUST_RULE`, with the precedence line, escaped markers, and a byte-identical prompt without a skill; the skill reaches batch and follow-up prompts and not the verify or Jev prompts; `configHash` unchanged on Default, changed by a content edit, unchanged by a rename, and in consensus changed by any active bot's skill; summary disclosure (identity line, panel column, Arabic); deleting a skill in use sets its bots to Default with the deleted-skill note, and a later skill choice clears the note; the prompt-token estimate grows by the skill; backup export and restore by name, including a missing skill restored as Default.

## Alternatives considered

- **The skill replaces the prompt** (the owner's first idea). Rejected: the output contract, the trust rule and the findings limit would then depend on each uploaded file, and one wrong skill could break parsing or open the bot to prompt injection.
- **Skills from the repository** (`.mergepilot.yml` or a `skills/` folder). Rejected for v1: PR authors could change how the reviewer behaves. A later ADR can add owner-approved repository skills read from the base commit, like rules files.
- **Several skills per bot.** Rejected for v1: one dropdown is simpler to reason about and to measure; an admin can merge two skills into one file.
- **Block deleting a skill in use** (409, naming the bots). Proposed first; the owner chose the fallback to Default, made visible by the delete dialog and the per-bot note (§4).

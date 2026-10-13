# ADR-0017: Reviewer Panel — Up to Five Review Bots per Workspace

- **Status:** Accepted (2026-10-13). R1 (storage, settings and API) is delivered with this ADR.
  R2 (worker execution) and R3 (dashboard UI) follow in their own PRs.
- **Related to:** ADR-0007, ADR-0008, ADR-0009, ADR-0012, ADR-0014, ADR-0015,
  docs/decisions.ar.md (batch 11, Q30)

## Context

The owner wants several bots to review the same pull request at the same time, each with its own
name, logo, provider, model and fallback chain, like duplicating the bot. His answers:

- **Identity:** one GitHub App. The bot's name and logo are shown inside the comment.
- **Output:** chosen in the settings: each bot posts its own review, or one merged review.
- **Count:** up to 5 bots.
- **Settings:** a tab per bot at the top of the model settings, each with an active toggle.

## Decision

### Model

1. **Slot 1 is the main bot.**
   - It is today's workspace settings: provider, model, effort, fallback and heavy model.
   - It gains `botName` (default "MergePilot") and `botLogo` (default `pilot`).
   - It is always active. Pausing a repository (ADR-0012) is how reviews stop.
2. **Slots 2–5 are extra bots, stored in `reviewer_bots`.** Each has:
   - `name`: 1–40 characters after trimming, unique in the workspace ignoring case, including the
     main bot's name;
   - `logo`: one key from the preset set;
   - `active`;
   - `provider`, `model` and `effort`;
   - `fallback`: up to 3 entries, under the same rules as the main fallback (no repeats of the bot's
     own model, a stored key for each entry).

   Extra bots have no heavy model. Their own provider needs no stored key when saved; R2 records a
   bot without a key as a skipped run (`no key`).
3. **Logo keys:** `pilot`, `owl`, `fox`, `robot`, `rocket`, `shield`, `bolt`, `eye`, `brain`,
   `star`, `leaf`, `wave` (`BOT_LOGOS` in `apps/app/src/core/bot-types.ts`).
   - Each is a small, original SVG at `apps/web/public/bots/<key>.svg` (R3). No third-party art.
   - A GitHub comment shows `<img src="{MERGEPILOT_BASE_URL}/bots/<key>.svg" width="20" height="20"
     alt="">` followed by the bot's name.
4. **Panel settings on the workspace:**
   - `panelMode`: `separate` (default) or `consensus`;
   - `panelMinAgreement`: an integer 1–5, default 1, used in consensus only. A finding must be
     found by at least this many bots. Critical and high findings are always kept, as in the Jev
     filter rule (ADR-0015 amendment).
5. **Runs.** Every bot gets its own `review_runs` row, with `bot_slot` (1–5, default 1) and
   `bot_name` (a snapshot of the name when the run was created).
   - The one-active-run-per-head index of ADR-0009 becomes
     `(workspace_id, repo_full_name, pull_number, head_sha, bot_slot)` for queued and running runs.
   - `ActiveRunExistsError` carries the bot slot.
6. **Budget.** The workspace's monthly budget covers all bots together. The per-review USD budget
   applies to each bot separately.

### Storage and API (R1)

- **Migration `0009_reviewer_panel.sql`:**
  - adds the `reviewer_bots` table: primary key `(workspace_id, slot)`, slot CHECK 2–5, name length
    CHECK, fallback array of at most 3, and a unique index on `(workspace_id, lower(name))`;
  - `workspace_id` references the organization with `ON DELETE CASCADE`, so deleting a workspace
    removes its bots;
  - adds `bot_name`, `bot_logo`, `panel_mode` and `panel_min_agreement` to `workspace_settings`;
  - adds `bot_slot` and `bot_name` to `review_runs`, and recreates the active-run index with
    `bot_slot`.

  The number skips 0008, which the parallel automatic-pricing change uses. The runner applies
  files in name order and needs no contiguous numbers.
- **Store** (`AppStore`, Postgres and memory):
  - `listReviewerBots`;
  - `upsertReviewerBot`: under the live-workspace lock. It throws `InvalidBotSlotError` for a slot
    outside 2–5 and `BotNameTakenError` for a taken name;
  - `deleteReviewerBot`: returns whether the bot existed;
  - `createReviewRun`: takes `botSlot` and `botName`;
  - `findActiveReviewRun`: takes an optional slot. With no slot it matches any bot.
- **API:**
  - `GET /api/workspaces/:id/bots` (member) returns the main bot, the extra bots by slot, the
    panel settings and the logo keys;
  - `PUT /api/workspaces/:id/bots/:slot` (admin/owner, slot 2–5) creates or replaces a bot. A
    taken name answers 409 `bot_name_taken`; a bad slot answers 400 `invalid_slot`;
  - `DELETE /api/workspaces/:id/bots/:slot` (admin/owner) answers 204, or 404 when the slot is
    empty;
  - `PUT /settings` accepts `botName`, `botLogo`, `panelMode` and `panelMinAgreement`. Left out
    keeps the stored value;
  - the runs list and run groups return `botSlot` and `botName`;
  - writes log `bot.created`, `bot.updated` (with the changed field names) and `bot.deleted`.

### Execution (R2, following PR)

1. **One BullMQ job per PR head, as today.** `processReviewJob` becomes an orchestrator:
   - the shared steps run once: installation, settings, PR fetch, pause check, repo config and the
     PR file list;
   - it then runs the main bot and every active extra bot in parallel (`Promise.allSettled`). Each
     bot has its own run row, heartbeat, model chain and credentials;
   - a bot whose provider has no stored key is recorded as a skipped run with detail `no key`;
   - one bot failing never stops the others.
2. **Separate mode:** each bot publishes its own review.
   - The summary starts with an identity header: logo, name and model label.
   - The review marker gains `bot=<slot>`. Slot 1 leaves it out, so old reviews stay valid.
   - Inline comments carry a hidden `<!-- mergepilot:bot=<slot> -->`.
   - Incremental base selection (ADR-0012), the "already reviewed this head" check and dedupe use
     only that bot's earlier reviews and comments. A comment with no bot marker belongs to slot 1.
3. **Consensus mode:** the bots run without publishing. Then:
   - **Merge.** A cluster is findings on the same path, with start lines within ±3, and either
     the same normalized title or, when the Jev judge is on, a "same issue?" answer of 0.8 or more
     from `judge.decide`.
   - **Keep.** Each cluster keeps its highest-severity version and lists which bots found it (n/N).
   - **Drop.** Clusters found by fewer than `panelMinAgreement` bots are dropped, except critical
     and high. The summary's collapsible section lists them as "below agreement (n)", so nothing is
     dropped silently.
   - **Publish.** One review is published as slot 1 under the header «Review panel». Its summary
     has a table of the bots: name, model, status, findings and cost.
   - **Runs.** Every bot's run row still records its own status, tokens, cost and findings.
4. **Logging:** `panel.start` (bots, mode), `panel.bot.done` (slot, status, ms) and
   `panel.publish` (mode, findings).

### UI (R3, following PR)

- **Settings:** a tab strip at the top of the model settings.
  - One tab per bot, showing its logo and name. A "+ Add bot" tab shows while there are fewer than
    5 bots.
  - Each extra bot's tab has:
    - an active toggle switch;
    - name, logo picker, provider, model, effort and fallback, reusing the existing components;
    - a "Copy from main bot" button;
    - a delete button with a confirm step.
  - The main bot's tab is today's settings plus name and logo. Its toggle is shown on and
    disabled, with a tooltip.
  - A "Panel output" card: a separate / consensus radio, and a minimum-agreement select shown only
    in consensus mode.
  - Admins and owners edit; members see the settings read-only.
- **Runs table:** each run shows a small bot chip (logo and name) under its provider and model.

## Consequences

- Until R2 ships, reviews run exactly as before: the worker runs slot 1 only. Extra bots can be
  saved but do not review yet.
- Each active bot costs a full review: a five-bot panel can cost about five times as much per PR.
  The monthly budget covers all bots together.
- A bot's provider without a stored key does not block saving. The run is skipped and says
  `no key`, so the gap is visible on the runs page.
- The runs list shows one row per bot per head. "Retry failed" still checks for any active run on
  the head before queuing, so it never starts a second job while a bot is running.

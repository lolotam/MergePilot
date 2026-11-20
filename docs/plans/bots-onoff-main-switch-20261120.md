# Spec and plan: on/off switch for every bot, main bot included (Heavy: one migration)

Owner report, 2026-11-20: the owner switched the three extra bots off, but the PR was still reviewed
by the main bot (MergePilot bot). The main bot's switch is shown on and locked (`botMainAlwaysOn`), and
nothing stores its state. Request: any bot, main included, can be switched off and then never runs;
every bot has an on/off switch in the admin dashboard settings. Tier: Heavy (migration).

## Findings (verified at 580fef0)

- Extra bots have `reviewer_bots.active`; `panelBots` (`apps/app/src/worker/panel.ts`) already drops
  inactive extras. The main bot (slot 1, from `workspace_settings`) is always added.
- `BotIdentityFields` locks the main switch on when `onActiveChange` is undefined.
- `GET /api/workspaces/:id/bots` returns `main.active: true` hard coded (`bot-routes.ts`).
- Precedent for a per-main-bot setting stored in `workspace_settings`: `call_timeout_ms`
  (migration 0018, `callTimeoutMs`): schema, store, contract, memory store, backup, web.
- Worker coupling to slot 1: consensus publishes as slot 1 (`process-review.ts` closes a run set as
  duplicates when `!main && panelActive && mode === 'consensus'`), `results.get(MAIN_BOT_SLOT) ?? duplicate`
  is the job result, `notePanelFailed`, `noteBudgetSkipped` use `MAIN_BOT_SLOT` with a fallback.

## Change

1. Migration `apps/app/migrations/0021_main_bot_active.sql` (next free number on main; check the folder):
   `ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS main_bot_active boolean NOT NULL DEFAULT true;`
   Default true keeps every existing workspace unchanged. Mirror in `db/schema.ts`.
2. Field `mainBotActive?: boolean` on `WorkspaceSettings` (`core/types.ts`), the pg store
   (`db/pg-settings.ts`: read, and write only when defined, like `callTimeoutMs`), the memory store
   (`core/memory-store.ts`), settings contract and validation (`api/contract.ts`,
   `api/settings-validation.ts`), backup export and restore (`db/pg-backup.ts`, `api/backup-restore.ts`)
   following the `callTimeoutMs` precedent file by file. Left out of a PUT = keep the stored value.
3. `GET /bots` returns `main.active: settings?.mainBotActive ?? true`.
4. Worker: `panelBots` adds the main bot only when `settings.mainBotActive !== false`.
   - Zero bots (main off and no active extra): `processReviewJob` returns
     `{ status: 'skipped', detail: 'all bots are off' }` before starting any run, logs `job.skipped`
     with reason `all-bots-off`, posts nothing. This holds for `@mergepilot review` too (off is off).
   - Main off, at least one extra on: the panel runs the extras only. Fix the slot 1 couplings:
     the `!main` duplicate branch must apply only when the main bot is active (a main run that another
     job holds), not when it is off; the lead and the job result fall back to the first run;
     consensus publishes through the first completed bot (`panel-consensus.ts` already falls back to
     `completed[0]`). Separate mode needs no change. The shared steps must not require the main bot's
     provider or model to be configured when it is off.
5. Web: the main bot tab's switch becomes real. `ReviewSettingsCard.tsx` passes `onActiveChange` to
   `BotIdentityFields` and saves `mainBotActive` through the existing settings patch hook (the switch
   saves at once, as the extra bots do). Remove the lock tooltip use for the main bot, keep the string
   in the dictionaries only if still used (do not leave dead i18n keys: remove `botMainAlwaysOn` from
   both dictionaries if unused). Show a short warning line when every bot is off ("reviews are
   paused for this workspace"), added to both Arabic and English dictionaries.
   `ReviewerPanel.tsx` / tab strip: mark an off bot visibly if tabs already show state; otherwise skip.
6. Tests (vitest): store contract for the new field (pg + memory share `store-contract-*`), contract
   validation, GET /bots `main.active`, worker: main off + extras on (consensus and separate) runs the
   extras and publishes; main off + extras off skips with no run rows and no comment; main on unchanged;
   web: main switch toggles and saves `mainBotActive`, warning shown when all are off. Mutation-check the
   worker filter (revert it, the new tests must fail).

## Out of scope

Changes to extra-bot switches, budget or pause logic, other languages.

## Gates

`pnpm typecheck` (rebuilds dist), `pnpm lint`, `pnpm exec vitest run <changed/added paths>`,
files under 400 lines (eslint max-lines), relative imports with `.js`, no new dependency. No git
commit, no push: the reviewer lands the work. Integration tests that need Postgres are run by CI.

## Addendum (owner, 2026-11-20): one master switch for all bots

- Same migration 0021 also adds `workspace_settings.bots_enabled boolean NOT NULL DEFAULT true` (field `botsEnabled`, same plumbing as `mainBotActive`: schema, stores, contract, validation, backup).
- Master off: the worker skips the whole review before starting any run (same skip as all-bots-off, reason `bots-off`, detail `bots are off`), `@mergepilot review` included. Each bot keeps its own saved switch, so turning the master back on restores the earlier state. Nothing is written to the PR.
- Web: a single switch at the top of the reviewer panel (`ReviewerPanel.tsx`), above the bot tabs, saved at once through the settings patch hook, with a hint line. When off, show the warning line and keep the per-bot switches usable (they only take effect once the master is on).
- i18n: Arabic and English strings for the label, hint and warning.
- Tests: store/contract/validation for `botsEnabled`; worker skip with the master off even when bots are on (mutation-check the guard); web switch saves `botsEnabled` and shows the warning.

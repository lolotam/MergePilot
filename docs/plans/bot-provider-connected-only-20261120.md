# Spec and plan: connected-only provider list + "all bots failed" note (Medium, one PR)

Owner request, 2026-11-20: each bot's AI provider list shows only providers that are connected
(key or subscription saved), not every provider; and a consensus panel whose bots all fail must
say so on the PR instead of staying silent. Tier: Medium. Implementer: OpenCode `opencode/big-pickle`.

## Part A: provider list shows only connected providers

Findings (verified in the code at 889a8b7):

- `apps/web/src/settings/bots/ExtraBotCard.tsx:235` already passes `options={keyedProviders}`.
- The main bot's select, `apps/web/src/settings/ReviewSettingsCard.tsx:280`, passes no `options`,
  so it lists every provider in `SAAS_PROVIDERS`. This is the bug.
- `ProviderSelect` (`apps/web/src/settings/providers.tsx:135`) already keeps the saved value in the
  list when it is not in `options`, and it filters subscription-only providers the server lacks.
- `keyedProviders` comes from `SettingsPage.tsx:58-60`: undefined for members and while keys load
  (then every provider is offered, unchanged behaviour), else the providers with a saved key or
  subscription, without judge-only types.

Change:

1. In `ReviewSettingsCard.tsx`, pass `options={keyedProviders}` to the main bot's `ProviderSelect`.
2. Do not change `ProviderSelect`, `SettingsPage.tsx`, the API, or any i18n text.
3. Tests (vitest, in `apps/web/src/settings/`): add a test next to the existing
   `ReviewSettingsCard.*.test.tsx` files. Cases: (a) `keyedProviders={['openrouter']}` and a stored
   provider `openrouter` lists exactly one option; (b) the stored provider is not keyed: it stays
   listed first, plus the keyed ones; (c) `keyedProviders` undefined lists all providers.
   Reuse the render helpers those test files already use.

Out of scope: the judge, heavy-model and fallback selects (they already take keyed lists).

## Part B: note on the PR when every bot failed

Findings:

- `apps/app/src/worker/panel-consensus.ts:55-58` returns `{ reviewUrl: null }` and logs only, when
  `completed.length === 0`. The PR stays silent (all bots failed, for example a shared OpenAI 429).
- A precedent exists: `apps/app/src/worker/budget-skip-note.ts` (`noteBudgetSkipped`) calls
  `postBudgetSkipNoteOnce` from `packages/github/src/budget-skip-note.ts`: one comment per head SHA,
  marker `<!-- mergepilot:budget-skip head=... -->`, Arabic and English text, best effort.
- The consensus call site is `apps/app/src/worker/panel.ts:193-196`; `noteBudgetSkipped` is wired in
  `apps/app/src/worker/process-review.ts`.

Change:

1. Add `packages/github/src/panel-failed-note.ts` with `postPanelFailedNoteOnce(client, params)`,
   modelled on `postBudgetSkipNoteOnce`: marker `<!-- mergepilot:panel-failed head=<sha> -->`,
   one comment per head, returns whether it posted, no-op when `client.createIssueComment` is
   missing. Params: owner, repo, pull_number, headSha, publisherLogin, language, and `reason`
   (a short, already-redacted line). Text: title "no reviewer finished"; body: the bots could not
   complete this review (quote `reason` neutralized with `neutralize(shortenDetail(reason))`),
   comment `@mergepilot review` to run it again. Arabic and English like the precedent. Export it
   from `packages/github/src/index.ts`.
2. Add `apps/app/src/worker/panel-failed-note.ts` with `notePanelFailed(ctx, results)`, modelled on
   `noteBudgetSkipped`. Condition: consensus mode, at least one bot ran, and every result has
   `status === 'failed'` (not skipped, not completed). Reason: the main bot's `detail` when it ran,
   else the first result's. Best effort: log and swallow errors. Call it where
   `noteBudgetSkipped` is called.
3. Never put secrets in the note: the result `detail` is already redacted by the bot run; still pass
   it through `shortenDetail` and `neutralize`.
4. Tests: `packages/github/src/panel-failed-note.test.ts` (posts once, skips when the marker exists,
   no-op without `createIssueComment`, Arabic and English text, reason neutralized) and
   `apps/app/src/worker/panel-failed-note.test.ts` (all failed posts; one completed does not; all
   skipped for budget does not; a failed post does not throw). Follow the style of
   `budget-skip-note.test.ts` files.

Out of scope: non-consensus panel modes, retries, provider fallback, dashboard changes.

## Gates

`pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run <changed paths>`, no new dependency, files under
400 lines (eslint max-lines), relative imports with `.js`, TS ESM. No `git commit`, no `git push`:
the reviewer lands the work.

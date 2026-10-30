import { expect, it } from 'vitest';
import {
  ActiveRunExistsError,
  BotNameTakenError,
  InvalidBotSlotError,
  WorkspaceDeletedError,
  type AppStore,
  type NewReviewRun,
  type ReviewerBot,
} from '../core/types.js';

const WS = 'ws-bots';
const WS_OTHER = 'ws-bots-other';

const bot = (overrides: Partial<ReviewerBot> = {}): ReviewerBot => ({
  slot: 2,
  name: 'Owl',
  logo: 'owl',
  active: true,
  provider: 'openai',
  model: 'gpt-5',
  effort: 'high',
  fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: null }],
  exploreEnabled: false,
  callTimeoutMs: null,
  ...overrides,
});

const run = (overrides: Partial<NewReviewRun> = {}): NewReviewRun => ({
  workspaceId: WS,
  installationId: 9,
  repoFullName: 'org/panel',
  pullNumber: 5,
  headSha: 'sha-panel',
  status: 'queued',
  costUsd: null,
  detail: null,
  ...overrides,
});

/** The reviewer panel (ADR-0017): extra bots, the main bot's settings and per-bot runs. */
export function defineReviewerBotContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  it('creates, lists (by slot), replaces and deletes extra bots per workspace', async () => {
    const store = await createStore();
    try {
      expect(await store.listReviewerBots(WS)).toEqual([]);
      const fox = bot({ slot: 4, name: 'Fox', logo: 'fox', active: false, effort: null, fallback: [] });
      expect(await store.upsertReviewerBot(WS, fox)).toEqual(fox);
      await store.upsertReviewerBot(WS, bot());
      expect(await store.listReviewerBots(WS)).toEqual([bot(), fox]);

      // Same slot replaces it; a bot may change the case of its own name.
      const renamed = bot({ name: 'OWL', model: 'gpt-5-mini', fallback: [] });
      await store.upsertReviewerBot(WS, renamed);
      expect(await store.listReviewerBots(WS)).toEqual([renamed, fox]);

      // Another workspace has its own bots, even with the same name and slot.
      await store.upsertReviewerBot(WS_OTHER, bot());
      expect(await store.listReviewerBots(WS_OTHER)).toEqual([bot()]);

      expect(await store.deleteReviewerBot(WS, 4)).toBe(true);
      expect(await store.deleteReviewerBot(WS, 4)).toBe(false);
      expect(await store.deleteReviewerBot(WS, 3)).toBe(false);
      expect(await store.listReviewerBots(WS)).toEqual([renamed]);
      expect(await store.listReviewerBots(WS_OTHER)).toEqual([bot()]);
    } finally {
      await cleanup?.();
    }
  });

  it('stores the exploration flag of a bot', async () => {
    const store = await createStore();
    try {
      await store.upsertReviewerBot(WS, bot({ exploreEnabled: true }));
      expect((await store.listReviewerBots(WS))[0]?.exploreEnabled).toBe(true);
      await store.upsertReviewerBot(WS, bot({ exploreEnabled: false }));
      expect((await store.listReviewerBots(WS))[0]?.exploreEnabled).toBe(false);
    } finally {
      await cleanup?.();
    }
  });

  it('keeps the stored exploration flag when an upsert leaves it undefined', async () => {
    const store = await createStore();
    try {
      await store.upsertReviewerBot(WS, bot({ exploreEnabled: true }));
      const saved = await store.upsertReviewerBot(WS, bot({ exploreEnabled: undefined }));
      expect(saved.exploreEnabled).toBe(true);
      expect((await store.listReviewerBots(WS))[0]?.exploreEnabled).toBe(true);
    } finally {
      await cleanup?.();
    }
  });

  it('rejects slots outside 2-5 and names taken by another bot, ignoring case, including the main bot', async () => {
    const store = await createStore();
    try {
      for (const slot of [0, 1, 6, 2.5]) {
        await expect(store.upsertReviewerBot(WS, bot({ slot }))).rejects.toBeInstanceOf(InvalidBotSlotError);
      }
      await store.upsertReviewerBot(WS, bot());
      await expect(store.upsertReviewerBot(WS, bot({ slot: 3, name: ' owl ' }))).rejects.toBeInstanceOf(
        BotNameTakenError,
      );
      // No settings yet: the main bot is "MergePilot".
      await expect(store.upsertReviewerBot(WS, bot({ slot: 3, name: 'mergepilot' }))).rejects.toBeInstanceOf(
        BotNameTakenError,
      );
      await store.saveSettings({ workspaceId: WS, provider: 'anthropic', model: 'm', language: 'en', monthlyBudgetUsd: null, botName: 'Hawk' });
      await expect(store.upsertReviewerBot(WS, bot({ slot: 3, name: 'HAWK' }))).rejects.toBeInstanceOf(
        BotNameTakenError,
      );
      await store.upsertReviewerBot(WS, bot({ slot: 3, name: 'MergePilot' }));
      expect((await store.listReviewerBots(WS)).map((b) => b.name)).toEqual(['Owl', 'MergePilot']);
      // The main bot's name is checked in the same locked write: it cannot take an extra bot's.
      await expect(
        store.saveSettings({ workspaceId: WS, provider: 'anthropic', model: 'm', language: 'en', monthlyBudgetUsd: null, botName: ' OWL ' }),
      ).rejects.toBeInstanceOf(BotNameTakenError);
      expect((await store.getSettings(WS))?.botName).toBe('Hawk');
    } finally {
      await cleanup?.();
    }
  });

  it('reads back the main bot and panel defaults; undefined on save keeps the stored values', async () => {
    const store = await createStore();
    try {
      const base = { workspaceId: WS, provider: 'anthropic' as const, model: 'm', language: 'en' as const, monthlyBudgetUsd: null };
      await store.saveSettings(base);
      expect(await store.getSettings(WS)).toMatchObject({
        botName: 'MergePilot',
        botLogo: 'pilot',
        panelMode: 'separate',
        panelMinAgreement: 1,
        exploreEnabled: false,
      });
      const panel = { botName: 'Pilot One', botLogo: 'rocket' as const, panelMode: 'consensus' as const, panelMinAgreement: 2, exploreEnabled: true };
      await store.saveSettings({ ...base, ...panel });
      expect(await store.getSettings(WS)).toMatchObject(panel);
      await store.saveSettings({ ...base, model: 'm2' });
      expect(await store.getSettings(WS)).toMatchObject({ ...panel, model: 'm2' });
    } finally {
      await cleanup?.();
    }
  });

  it('records the bot of each run and allows one active run per head and bot slot', async () => {
    const store = await createStore();
    try {
      const main = await store.createReviewRun(run());
      expect(main).toMatchObject({ botSlot: 1, botName: null });
      expect(await store.getReviewRun(WS, main.id)).toMatchObject({ botSlot: 1, botName: null });

      await new Promise((resolve) => setTimeout(resolve, 15));
      const owl = await store.createReviewRun(run({ botSlot: 2, botName: 'Owl', status: 'running' }));
      expect(owl).toMatchObject({ botSlot: 2, botName: 'Owl' });
      const listed = await store.listReviewRuns(WS, { limit: 10 });
      expect(listed.runs.map((r) => [r.botSlot, r.botName]).sort()).toEqual([[1, null], [2, 'Owl']]);
      const groups = await store.listReviewRunGroups(WS, {});
      expect(groups.groups[0]?.runs.map((r) => r.botSlot).sort()).toEqual([1, 2]);

      const conflict = await store.createReviewRun(run({ botSlot: 2, botName: 'Owl' })).catch((e: unknown) => e);
      expect(conflict).toBeInstanceOf(ActiveRunExistsError);
      expect((conflict as ActiveRunExistsError).botSlot).toBe(2);
      await expect(store.createReviewRun(run({ status: 'running' }))).rejects.toBeInstanceOf(ActiveRunExistsError);

      expect((await store.findActiveReviewRun(WS, 'org/panel', 5, 'sha-panel', 2))?.id).toBe(owl.id);
      expect((await store.findActiveReviewRun(WS, 'org/panel', 5, 'sha-panel', 1))?.id).toBe(main.id);
      expect(await store.findActiveReviewRun(WS, 'org/panel', 5, 'sha-panel', 3)).toBeNull();
      expect(await store.findActiveReviewRun(WS, 'org/panel', 5, 'sha-panel')).not.toBeNull();

      await store.finishReviewRun(WS, owl.id, { status: 'failed', costUsd: null, detail: 'x' });
      const failed = await store.listLatestFailedRuns(WS, { repo: ['org/panel'] });
      expect(failed.map((r) => [r.id, r.botSlot, r.botName])).toEqual([[owl.id, 2, 'Owl']]);
    } finally {
      await cleanup?.();
    }
  });

  it('removes the bots with their workspace and refuses bot writes afterwards', async () => {
    const store = await createStore();
    try {
      await store.upsertReviewerBot(WS, bot());
      await store.upsertReviewerBot(WS_OTHER, bot());
      await store.deleteWorkspace(WS);
      expect(await store.listReviewerBots(WS)).toEqual([]);
      expect(await store.listReviewerBots(WS_OTHER)).toEqual([bot()]);
      await expect(store.upsertReviewerBot(WS, bot({ slot: 3, name: 'Late' }))).rejects.toBeInstanceOf(
        WorkspaceDeletedError,
      );
    } finally {
      await cleanup?.();
    }
  });
}

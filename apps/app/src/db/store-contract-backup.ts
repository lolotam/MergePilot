import { expect, it } from 'vitest';
import {
  BotNameTakenError,
  InvalidBotSlotError,
  WorkspaceDeletedError,
  type AppStore,
  type ReviewerBot,
  type StoredCredential,
  type WorkspaceSettings,
} from '../core/types.js';

const WS = 'ws-backup';
const WS_OTHER = 'ws-backup-other';

const settings = (overrides: Partial<WorkspaceSettings> = {}): WorkspaceSettings => ({
  workspaceId: WS,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  language: 'ar',
  monthlyBudgetUsd: 25,
  ...overrides,
});

const bot = (overrides: Partial<ReviewerBot> = {}): ReviewerBot => ({
  slot: 2,
  name: 'Owl',
  logo: 'owl',
  active: true,
  provider: 'openai',
  model: 'gpt-5',
  effort: null,
  fallback: [],
  exploreEnabled: false,
  ...overrides,
});

const credential = (provider: StoredCredential['provider'], last4: string): StoredCredential => ({
  id: crypto.randomUUID(),
  workspaceId: WS,
  provider,
  ciphertext: `sealed-${last4}`,
  keyVersion: 1,
  last4,
  createdBy: 'u-owner',
  createdAt: new Date('2026-10-13T00:00:00Z'),
  baseUrl: null,
});

/** Settings restore (ADR-0018): one all-or-nothing write of settings, extra bots and keys. */
export function defineBackupRestoreContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  it('restores settings, replaces the extra bots and upserts keys, leaving untouched sections alone', async () => {
    const store = await createStore();
    try {
      await store.saveSettings(settings({ botName: 'Old main' }));
      await store.upsertReviewerBot(WS, bot({ slot: 3, name: 'Old extra' }));
      await store.saveCredential(credential('openai', '1111'));
      await store.saveCredential(credential('gemini', '2222'));
      await store.upsertReviewerBot(WS_OTHER, bot({ name: 'Other ws bot' }));

      await store.restoreWorkspace(WS, {
        settings: settings({ model: 'claude-opus-5', botName: 'Old extra', panelMode: 'consensus' }),
        bots: [bot(), bot({ slot: 5, name: 'Fox', logo: 'fox', active: false })],
        credentials: [credential('openai', '9999'), credential('typesafe', '3333')],
      });

      expect(await store.getSettings(WS)).toMatchObject({ model: 'claude-opus-5', botName: 'Old extra', panelMode: 'consensus' });
      expect((await store.listReviewerBots(WS)).map((b) => [b.slot, b.name, b.active])).toEqual([
        [2, 'Owl', true],
        [5, 'Fox', false],
      ]);
      const keys = (await store.listCredentials(WS)).map((c) => `${c.provider}:${c.last4}`).sort();
      expect(keys).toEqual(['gemini:2222', 'openai:9999', 'typesafe:3333']);
      expect((await store.getCredential(WS, 'openai'))?.ciphertext).toBe('sealed-9999');
      expect((await store.listReviewerBots(WS_OTHER)).map((b) => b.name)).toEqual(['Other ws bot']);

      // Only the keys: settings and bots stay; [] bots would remove them all.
      await store.restoreWorkspace(WS, { credentials: [credential('gemini', '4444')] });
      expect((await store.getSettings(WS))?.model).toBe('claude-opus-5');
      expect(await store.listReviewerBots(WS)).toHaveLength(2);
      await store.restoreWorkspace(WS, { bots: [] });
      expect(await store.listReviewerBots(WS)).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });

  it('writes nothing when a bot name or slot clashes, or the workspace is gone', async () => {
    const store = await createStore();
    try {
      await store.saveSettings(settings({ botName: 'Hawk' }));
      await store.upsertReviewerBot(WS, bot());
      const attempt = (restore: Parameters<AppStore['restoreWorkspace']>[1]) => store.restoreWorkspace(WS, restore).catch((e: unknown) => e);

      expect(
        await attempt({ settings: settings({ model: 'changed' }), bots: [bot({ name: ' hawk ' })], credentials: [credential('openai', '5555')] }),
      ).toBeInstanceOf(BotNameTakenError);
      expect(await attempt({ bots: [bot({ slot: 3 }), bot({ slot: 4, name: 'OWL' })] })).toBeInstanceOf(BotNameTakenError);
      expect(await attempt({ settings: settings({ botName: 'owl' }) })).toBeInstanceOf(BotNameTakenError);
      expect(await attempt({ bots: [bot({ slot: 1, name: 'One' })] })).toBeInstanceOf(InvalidBotSlotError);
      expect(await attempt({ bots: [bot({ slot: 3, name: 'A' }), bot({ slot: 3, name: 'B' })] })).toBeInstanceOf(InvalidBotSlotError);

      expect(await store.getSettings(WS)).toMatchObject({ model: 'claude-sonnet-5-5', botName: 'Hawk' });
      expect(await store.listReviewerBots(WS)).toEqual([bot()]);
      expect(await store.getCredential(WS, 'openai')).toBeNull();

      // Renaming the main bot to an old extra bot's name is fine when the bots are replaced too.
      await store.restoreWorkspace(WS, { settings: settings({ botName: 'Owl' }), bots: [bot({ name: 'Hawk' })] });
      expect((await store.getSettings(WS))?.botName).toBe('Owl');

      await store.deleteWorkspace(WS);
      expect(await store.restoreWorkspace(WS, { settings: settings() }).catch((e: unknown) => e)).toBeInstanceOf(
        WorkspaceDeletedError,
      );
    } finally {
      await cleanup?.();
    }
  });
}

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import { SettingsChangedError, type ReviewerBot, type WorkspaceSettings } from '../core/types.js';
import { createTestDb } from './test-db.js';

const WS = 'ws-call-timeout';
const WS_OTHER = 'ws-call-timeout-other';

const base: WorkspaceSettings = {
  workspaceId: WS,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  language: 'en',
  monthlyBudgetUsd: null,
};
const otherBase: WorkspaceSettings = { ...base, workspaceId: WS_OTHER };

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
  callTimeoutMs: null,
  ...overrides,
});

describe('MemoryStore callTimeoutMs', () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); });

  it('reads null when unset and keeps a saved override across unrelated writes', async () => {
    await store.saveSettings(base);
    expect((await store.getSettings(WS))?.callTimeoutMs).toBeNull();
    await store.upsertReviewerBot(WS, bot());
    expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBeNull();

    await store.saveSettings({ ...base, callTimeoutMs: 600000 });
    expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
    await store.saveSettings({ ...base, monthlyBudgetUsd: 12 });
    expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
  });

  it('keeps a saved override when an update writes undefined', async () => {
    await store.saveSettings({ ...base, callTimeoutMs: 600000 });
    await store.saveSettings({ ...base, callTimeoutMs: undefined });
    expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
  });

  it('resets to inheritance with an explicit null', async () => {
    await store.saveSettings({ ...base, callTimeoutMs: 600000 });
    await store.saveSettings({ ...base, callTimeoutMs: null });
    expect((await store.getSettings(WS))?.callTimeoutMs).toBeNull();
  });

  it('keeps the main and extra bot overrides independent', async () => {
    await store.saveSettings({ ...base, callTimeoutMs: 600000 });
    await store.upsertReviewerBot(WS, bot({ callTimeoutMs: 900000 }));
    await store.upsertReviewerBot(WS, bot({ slot: 3, name: 'Fox' }));
    expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(900000);
    expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
    await store.saveSettings({ ...otherBase, callTimeoutMs: 1200000 });
    await store.upsertReviewerBot(WS_OTHER, bot({ callTimeoutMs: 1200000 }));
    expect((await store.listReviewerBots(WS_OTHER))[0]?.callTimeoutMs).toBe(1200000);
    expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(900000);
    expect((await store.listReviewerBots(WS))[1]?.callTimeoutMs).toBeNull();
    expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
  });

  it('keeps unrelated bot fields when a later write leaves the timeout out', async () => {
    await store.upsertReviewerBot(WS, bot({ exploreEnabled: true, callTimeoutMs: 600000 }));
    const { callTimeoutMs: _timeout, ...unrelated } = bot({ exploreEnabled: true, skillId: null });
    await store.upsertReviewerBot(WS, unrelated);
    await store.upsertReviewerBot(WS, { ...unrelated, callTimeoutMs: undefined });
    expect((await store.listReviewerBots(WS))[0]?.exploreEnabled).toBe(true);
    expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(600000);
    await store.upsertReviewerBot(WS, { ...unrelated, callTimeoutMs: null });
    expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBeNull();
  });

  it('rejects a stale expected settings write without losing the timeout', async () => {
    await store.saveSettings({ ...base, callTimeoutMs: 600000 });
    const previous = await store.getSettings(WS);
    expect(previous?.callTimeoutMs).toBe(600000);
    await store.saveSettings({ ...base, callTimeoutMs: 900000 });
    await expect(store.saveSettings({ ...base, monthlyBudgetUsd: 77 }, { expected: previous })).rejects.toThrow(SettingsChangedError);
    expect((await store.getSettings(WS))?.callTimeoutMs).toBe(900000);
  });

  it('restores explicit numeric overrides and resets with null', async () => {
    await store.saveSettings({ ...base, callTimeoutMs: 300000 });
    await store.upsertReviewerBot(WS, bot({ callTimeoutMs: 450000 }));
    await store.restoreWorkspace(WS, {
      settings: { ...base, callTimeoutMs: 600000 },
      bots: [bot({ callTimeoutMs: 900000 })],
    });
    expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
    expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(900000);
    await store.restoreWorkspace(WS, { settings: { ...base, callTimeoutMs: null }, bots: [bot({ callTimeoutMs: null })] });
    expect((await store.getSettings(WS))?.callTimeoutMs).toBeNull();
    expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBeNull();
  });
});

describe('PgStore callTimeoutMs', { timeout: 30000 }, () => {
  it('reads null when unset and keeps a saved override across unrelated writes', async () => {
    const { store, close } = await createTestDb(undefined, { workspaces: [WS] });
    try {
      await store.saveSettings(base);
      expect((await store.getSettings(WS))?.callTimeoutMs).toBeNull();
      await store.upsertReviewerBot(WS, bot());
      expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBeNull();

      await store.saveSettings({ ...base, callTimeoutMs: 600000 });
      expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
      await store.saveSettings({ ...base, monthlyBudgetUsd: 12 });
      expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
    } finally {
      await close();
    }
  });

  it('keeps a saved override when an update writes undefined and resets with null', async () => {
    const { store, close } = await createTestDb(undefined, { workspaces: [WS] });
    try {
      await store.saveSettings({ ...base, callTimeoutMs: 600000 });
      await store.saveSettings({ ...base, callTimeoutMs: undefined });
      expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
      await store.saveSettings({ ...base, callTimeoutMs: null });
      expect((await store.getSettings(WS))?.callTimeoutMs).toBeNull();
    } finally {
      await close();
    }
  });

  it('keeps the main and extra bot overrides independent', async () => {
    const { store, close } = await createTestDb(undefined, { workspaces: [WS, WS_OTHER] });
    try {
      await store.saveSettings({ ...base, callTimeoutMs: 600000 });
      await store.upsertReviewerBot(WS, bot({ callTimeoutMs: 900000 }));
      await store.upsertReviewerBot(WS, bot({ slot: 3, name: 'Fox' }));
      expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(900000);
      expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);

      await store.saveSettings({ ...otherBase, callTimeoutMs: 1200000 });
      await store.upsertReviewerBot(WS_OTHER, bot({ callTimeoutMs: 1200000 }));
      expect((await store.listReviewerBots(WS_OTHER))[0]?.callTimeoutMs).toBe(1200000);
      expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(900000);
      expect((await store.listReviewerBots(WS))[1]?.callTimeoutMs).toBeNull();
      expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
    } finally {
      await close();
    }
  });

  it('keeps unrelated bot fields when a later write leaves the timeout out', async () => {
    const { store, close } = await createTestDb(undefined, { workspaces: [WS] });
    try {
      await store.upsertReviewerBot(WS, bot({ exploreEnabled: true, callTimeoutMs: 600000 }));
      const { callTimeoutMs: _timeout, ...unrelated } = bot({ exploreEnabled: true, skillId: null });
      await store.upsertReviewerBot(WS, unrelated);
      await store.upsertReviewerBot(WS, { ...unrelated, callTimeoutMs: undefined });
      expect((await store.listReviewerBots(WS))[0]?.exploreEnabled).toBe(true);
      expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(600000);
      await store.upsertReviewerBot(WS, { ...unrelated, callTimeoutMs: null });
      expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBeNull();
    } finally {
      await close();
    }
  });

  it('rejects a stale expected settings write without losing the timeout', async () => {
    const { store, close } = await createTestDb(undefined, { workspaces: [WS] });
    try {
      await store.saveSettings({ ...base, callTimeoutMs: 600000 });
      const previous = await store.getSettings(WS);
      expect(previous?.callTimeoutMs).toBe(600000);
      await store.saveSettings({ ...base, callTimeoutMs: 900000 });
      await expect(store.saveSettings({ ...base, monthlyBudgetUsd: 77 }, { expected: previous })).rejects.toThrow(SettingsChangedError);
      expect((await store.getSettings(WS))?.callTimeoutMs).toBe(900000);
    } finally {
      await close();
    }
  });

  it('restores explicit numeric overrides and resets with null', async () => {
    const { store, close } = await createTestDb(undefined, { workspaces: [WS] });
    try {
      await store.saveSettings({ ...base, callTimeoutMs: 300000 });
      await store.upsertReviewerBot(WS, bot({ callTimeoutMs: 450000 }));
      await store.restoreWorkspace(WS, {
        settings: { ...base, callTimeoutMs: 600000 },
        bots: [bot({ callTimeoutMs: 900000 })],
      });
      expect((await store.getSettings(WS))?.callTimeoutMs).toBe(600000);
      expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBe(900000);
      await store.restoreWorkspace(WS, { settings: { ...base, callTimeoutMs: null }, bots: [bot({ callTimeoutMs: null })] });
      expect((await store.getSettings(WS))?.callTimeoutMs).toBeNull();
      expect((await store.listReviewerBots(WS))[0]?.callTimeoutMs).toBeNull();
    } finally {
      await close();
    }
  });
});

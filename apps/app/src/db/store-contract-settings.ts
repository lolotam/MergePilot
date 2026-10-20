import { expect, it } from 'vitest';
import { SettingsChangedError, type AppStore, type WorkspaceSettings } from '../core/types.js';

const initial: WorkspaceSettings = {
  workspaceId: 'ws-settings-test',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  language: 'ar',
  monthlyBudgetUsd: 50,
  repoColors: { 'acme/repo': 'sky' },
};

/** Compare-and-write settings part of the shared AppStore contract. */
export function defineSettingsContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  it('creates settings with expected null and writes with a matching settings snapshot', async () => {
    const store = await createStore();
    try {
      expect(await store.getSettings(initial.workspaceId)).toBeNull();
      await store.saveSettings(initial, { expected: null });
      const previous = await store.getSettings(initial.workspaceId);
      expect(previous).toMatchObject(initial);
      await store.saveSettings({ ...initial, monthlyBudgetUsd: 75 }, { expected: structuredClone(previous) });
      expect(await store.getSettings(initial.workspaceId)).toEqual({ ...previous, monthlyBudgetUsd: 75 });
    } finally {
      await cleanup?.();
    }
  });

  it('rejects stale expected settings without overwriting the current row', async () => {
    const store = await createStore();
    try {
      await store.saveSettings(initial);
      const previous = await store.getSettings(initial.workspaceId);
      await store.saveSettings({ ...initial, repoColors: { 'acme/repo': 'emerald' } });
      const current = await store.getSettings(initial.workspaceId);
      expect(current).not.toEqual(previous);
      await expect(store.saveSettings({ ...initial, monthlyBudgetUsd: 75 }, { expected: previous }))
        .rejects.toThrow(SettingsChangedError);
      expect(await store.getSettings(initial.workspaceId)).toEqual(current);
    } finally {
      await cleanup?.();
    }
  });

  it('rejects expected null when a settings row already exists', async () => {
    const store = await createStore();
    try {
      await store.saveSettings(initial);
      const current = await store.getSettings(initial.workspaceId);
      await expect(store.saveSettings({ ...initial, monthlyBudgetUsd: 75 }, { expected: null }))
        .rejects.toThrow(SettingsChangedError);
      expect(await store.getSettings(initial.workspaceId)).toEqual(current);
    } finally {
      await cleanup?.();
    }
  });

  it('allows only one concurrent write with the same expected settings', async () => {
    const store = await createStore();
    try {
      await store.saveSettings(initial);
      const previous = await store.getSettings(initial.workspaceId);
      const outcomes = await Promise.allSettled([
        store.saveSettings({ ...initial, monthlyBudgetUsd: 75 }, { expected: previous }),
        store.saveSettings({ ...initial, monthlyBudgetUsd: 100 }, { expected: previous }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(SettingsChangedError);
      const winner = outcomes[0]?.status === 'fulfilled' ? 75 : 100;
      expect(await store.getSettings(initial.workspaceId)).toEqual({ ...previous, monthlyBudgetUsd: winner });
    } finally {
      await cleanup?.();
    }
  });

  it('keeps unconditional writes when expected is omitted', async () => {
    const store = await createStore();
    try {
      await store.saveSettings(initial);
      await store.saveSettings({ ...initial, monthlyBudgetUsd: 75 });
      expect((await store.getSettings(initial.workspaceId))?.monthlyBudgetUsd).toBe(75);
      await store.saveSettings({ ...initial, monthlyBudgetUsd: 100 }, {});
      expect((await store.getSettings(initial.workspaceId))?.monthlyBudgetUsd).toBe(100);
    } finally {
      await cleanup?.();
    }
  });
}

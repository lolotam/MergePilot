import { expect, it } from 'vitest';
import type { PriceEntry } from '@mergepilot/engine';
import type { AppStore, WorkspaceSettings } from '../core/types.js';

const entry = (over: Partial<PriceEntry>): PriceEntry => ({
  provider: 'anthropic',
  model: 'claude-x',
  inputPerMTok: 3,
  outputPerMTok: 15,
  source: 'models.dev',
  ...over,
});

const T1 = new Date('2026-10-12T02:30:00.000Z');
const T2 = new Date('2026-10-13T02:30:00.000Z');

/** Model prices and price overrides part of the AppStore contract (ADR-0016). */
export function definePricesContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  it('replaces one source at a time: upserts its rows and deletes the ones it no longer lists', async () => {
    const store = await createStore();
    try {
      expect(await store.pricesFetchedAt()).toEqual([]);
      expect(
        await store.replaceModelPrices(
          'models.dev',
          [entry({ cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }), entry({ model: 'old-model', inputPerMTok: 1, outputPerMTok: 2 })],
          T1,
        ),
      ).toBe(2);
      await store.replaceModelPrices('openrouter', [entry({ provider: 'openrouter', model: 'a/b', inputPerMTok: 0.5, outputPerMTok: 1, source: 'openrouter' })], T1);

      expect(await store.getModelPrice('anthropic', 'claude-x')).toEqual({
        provider: 'anthropic',
        model: 'claude-x',
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        source: 'models.dev',
        fetchedAt: T1,
      });

      // The new models.dev list drops old-model and changes claude-x; OpenRouter rows are untouched.
      await store.replaceModelPrices('models.dev', [entry({ inputPerMTok: 2.5, outputPerMTok: 12.5 })], T2);
      expect(await store.getModelPrice('anthropic', 'old-model')).toBeNull();
      const updated = await store.getModelPrice('anthropic', 'claude-x');
      expect(updated).toMatchObject({ inputPerMTok: 2.5, outputPerMTok: 12.5, fetchedAt: T2 });
      expect(updated?.cacheReadPerMTok).toBeUndefined();
      expect(await store.getModelPrice('openrouter', 'a/b')).toMatchObject({ inputPerMTok: 0.5, source: 'openrouter' });

      const fetched = await store.pricesFetchedAt();
      expect([...fetched].sort((a, b) => a.source.localeCompare(b.source))).toEqual([
        { source: 'models.dev', fetchedAt: T2 },
        { source: 'openrouter', fetchedAt: T1 },
      ]);
    } finally {
      await cleanup?.();
    }
  });

  it('drops the rows a new list no longer has by key, even when both refreshes share a timestamp', async () => {
    const store = await createStore();
    try {
      const a = entry({ provider: 'openrouter', model: 'a', inputPerMTok: 1, outputPerMTok: 1, source: 'openrouter' });
      const b = entry({ provider: 'openrouter', model: 'b', inputPerMTok: 2, outputPerMTok: 2, source: 'openrouter' });
      await store.replaceModelPrices('openrouter', [a, b], T1);
      await store.replaceModelPrices('openrouter', [{ ...a, inputPerMTok: 5 }], T1);
      expect((await store.getModelPrice('openrouter', 'a'))?.inputPerMTok).toBe(5);
      expect(await store.getModelPrice('openrouter', 'b')).toBeNull();
    } finally {
      await cleanup?.();
    }
  });

  it('finds a price exactly first, then case-insensitively, and lists prices for many models', async () => {
    const store = await createStore();
    try {
      await store.replaceModelPrices(
        'openrouter',
        [
          entry({ provider: 'openrouter', model: 'Vendor/Model-A', inputPerMTok: 1, outputPerMTok: 1, source: 'openrouter' }),
          entry({ provider: 'openrouter', model: 'vendor/model-b', inputPerMTok: 2, outputPerMTok: 2, source: 'openrouter' }),
          entry({ provider: 'openrouter', model: 'vendor/model-B', inputPerMTok: 3, outputPerMTok: 3, source: 'openrouter' }),
        ],
        T1,
      );
      expect((await store.getModelPrice('openrouter', 'vendor/model-a'))?.model).toBe('Vendor/Model-A');
      expect((await store.getModelPrice('openrouter', 'vendor/model-B'))?.inputPerMTok).toBe(3);
      expect((await store.getModelPrice('openrouter', 'vendor/model-b'))?.inputPerMTok).toBe(2);
      expect(await store.getModelPrice('anthropic', 'vendor/model-a')).toBeNull();
      // Two ids differ only in case: an inexact lookup is ambiguous, so the price stays unknown.
      expect(await store.getModelPrice('openrouter', 'VENDOR/MODEL-B')).toBeNull();

      const listed = await store.listModelPrices([
        { provider: 'openrouter', model: 'VENDOR/MODEL-A' },
        { provider: 'anthropic', model: 'none' },
      ]);
      expect(listed.map((p) => p.model)).toEqual(['Vendor/Model-A']);
      expect(await store.listModelPrices([])).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });

  it('saves price overrides with the settings; left out keeps them and [] clears them', async () => {
    const store = await createStore();
    try {
      const base: WorkspaceSettings = {
        workspaceId: 'ws-settings-test',
        provider: 'anthropic',
        model: 'm',
        language: 'en',
        monthlyBudgetUsd: null,
      };
      await store.saveSettings(base);
      expect((await store.getSettings('ws-settings-test'))?.priceOverrides).toEqual([]);

      const overrides = [
        { provider: 'custom', model: 'my-model', inputPerMTok: 1, outputPerMTok: 2 },
        { provider: 'typesafe', model: 'jev-latest', inputPerMTok: 0.05, outputPerMTok: 0, cacheReadPerMTok: 0.01 },
      ];
      await store.saveSettings({ ...base, priceOverrides: overrides });
      expect((await store.getSettings('ws-settings-test'))?.priceOverrides).toEqual(overrides);
      await store.saveSettings({ ...base, model: 'm2' });
      expect((await store.getSettings('ws-settings-test'))?.priceOverrides).toEqual(overrides);
      await store.saveSettings({ ...base, priceOverrides: [] });
      expect((await store.getSettings('ws-settings-test'))?.priceOverrides).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });
}

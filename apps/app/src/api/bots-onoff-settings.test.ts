import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import type { WorkspaceSettings } from '../core/types.js';
import { SettingsSchema } from './contract.js';
import { mergeSettings } from './settings-validation.js';

const required = { provider: 'anthropic' as const, model: 'model', language: 'en' as const };
const stored: WorkspaceSettings = { workspaceId: 'ws-1', ...required, monthlyBudgetUsd: 50 };

describe('bot on/off switches in the settings contract', () => {
  it('accepts both booleans and rejects non-boolean values', () => {
    expect(SettingsSchema.parse({ ...required, mainBotActive: false, botsEnabled: true }))
      .toMatchObject({ mainBotActive: false, botsEnabled: true });
    expect(SettingsSchema.safeParse({ ...required, mainBotActive: 'off' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...required, botsEnabled: 0 }).success).toBe(false);
  });

  it('keeps the stored switches when a PUT leaves them out and writes explicit values', async () => {
    const store = new MemoryStore();
    const previous = { ...stored, mainBotActive: false, botsEnabled: false };
    await store.saveSettings(previous);

    // The patch leaves omitted switches out so the store keeps what it already has.
    const patch = mergeSettings('ws-1', previous, { ...required, monthlyBudgetUsd: 75 });
    expect(patch).not.toHaveProperty('mainBotActive');
    expect(patch).not.toHaveProperty('botsEnabled');
    await store.saveSettings(patch);
    expect(await store.getSettings('ws-1')).toMatchObject({ mainBotActive: false, botsEnabled: false });

    const current = await store.getSettings('ws-1');
    await store.saveSettings(mergeSettings('ws-1', current, { ...required, mainBotActive: true, botsEnabled: true }));
    expect(await store.getSettings('ws-1')).toMatchObject({ mainBotActive: true, botsEnabled: true });
  });
});

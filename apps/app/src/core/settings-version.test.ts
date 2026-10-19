import { describe, expect, it } from 'vitest';
import { getSettingsVersion } from './settings-version.js';
import type { WorkspaceSettings } from './types.js';

const settings: WorkspaceSettings = {
  workspaceId: 'ws-1', provider: 'anthropic', model: 'model', language: 'en', monthlyBudgetUsd: 50,
  repoColors: { 'acme/z': 'sky', 'acme/a': 'teal' },
};

describe('getSettingsVersion', () => {
  it('sorts object keys recursively without changing the settings', () => {
    const original = structuredClone(settings);
    const reordered = {
      repoColors: { 'acme/a': 'teal' as const, 'acme/z': 'sky' as const },
      monthlyBudgetUsd: 50, language: 'en' as const, model: 'model', provider: 'anthropic' as const, workspaceId: 'ws-1',
    };
    expect(getSettingsVersion(settings)).toMatch(/^[a-f0-9]{64}$/);
    expect(getSettingsVersion(settings)).toBe(getSettingsVersion(reordered));
    expect(settings).toEqual(original);
  });

  it('has a stable version for no settings, different from a stored row', () => {
    expect(getSettingsVersion(null)).toBe(getSettingsVersion(null));
    expect(getSettingsVersion(null)).not.toBe(getSettingsVersion(settings));
  });

  it('changes when a value or the order of a fallback list changes', () => {
    expect(getSettingsVersion(settings)).not.toBe(getSettingsVersion({ ...settings, monthlyBudgetUsd: 75 }));
    const fallback = [{ provider: 'anthropic' as const, model: 'one' }, { provider: 'anthropic' as const, model: 'two' }];
    expect(getSettingsVersion({ ...settings, fallback })).not.toBe(getSettingsVersion({ ...settings, fallback: [...fallback].reverse() }));
  });
});

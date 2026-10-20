import { describe, expect, it } from 'vitest';
import { reconcileSettingsPatch } from './settings-merge.js';
import type { SettingsUpdate } from './contract.js';
import type { WorkspaceSettings } from '../core/types.js';

const required = { provider: 'anthropic' as const, model: 'model', language: 'en' as const };
const stored: WorkspaceSettings = { workspaceId: 'ws-1', ...required, monthlyBudgetUsd: 50 };

/** A body that leaves the group members out: the client sends the one field it changed. */
function partialBody(patch: Partial<Omit<SettingsUpdate, 'base'>>): Omit<SettingsUpdate, 'base'> {
  return patch as Omit<SettingsUpdate, 'base'>;
}

describe('reconcileSettingsPatch', () => {
  it('drops unchanged optional fields and uses current required fields', () => {
    const previous = { ...stored, provider: 'openai' as const, model: 'new', language: 'ar' as const, monthlyBudgetUsd: 75 };
    expect(reconcileSettingsPatch({ ...required, monthlyBudgetUsd: 50 }, { ...required, monthlyBudgetUsd: 50 }, previous))
      .toEqual({ provider: 'openai', model: 'new', language: 'ar' });
  });

  it('writes an edit only while its base matches the stored field', () => {
    const patch = { ...required, monthlyBudgetUsd: 75 };
    expect(reconcileSettingsPatch(patch, { monthlyBudgetUsd: 50 }, stored)).toEqual(patch);
    expect(reconcileSettingsPatch(patch, { monthlyBudgetUsd: 10 }, stored)).toBeNull();
  });

  it.each([[undefined, null], [null, undefined]])('treats undefined and null as unchanged (%s, %s)', (value, base) => {
    expect(reconcileSettingsPatch({ ...required, effort: value }, { effort: base }, { ...stored, effort: 'high' }))
      .toEqual(required);
    expect(reconcileSettingsPatch({ ...required, effort: 'high' }, { effort: base }, { ...stored, effort: value }))
      .toEqual({ ...required, effort: 'high' });
  });

  it('compares object keys without order and normalizes nested undefined values', () => {
    const fallback = [{ provider: 'openai' as const, model: 'one', effort: undefined }];
    expect(reconcileSettingsPatch({ ...required, fallback }, {
      fallback: [{ effort: null, model: 'one', provider: 'openai' }],
    }, { ...stored, fallback: [] })).toEqual(required);
    expect(reconcileSettingsPatch({ ...required, fallback: [{ provider: 'openai', model: 'one', effort: null }] }, {
      fallback: [{ model: 'one', provider: 'openai' }],
    }, { ...stored, fallback: [] })).toEqual(required);
    expect(reconcileSettingsPatch({ ...required, repoColors: { b: 'teal', a: 'sky' } }, {
      repoColors: { a: 'sky', b: 'teal' },
    }, { ...stored, repoColors: {} })).toEqual(required);
  });

  it('preserves array order when classifying edits', () => {
    const fallback = [{ provider: 'openai' as const, model: 'one' }, { provider: 'openai' as const, model: 'two' }];
    expect(reconcileSettingsPatch({ ...required, fallback: [...fallback].reverse() }, { fallback }, { ...stored, fallback: [] }))
      .toBeNull();
  });

  it('does not check fields absent from base, including an inherited base key', () => {
    const patch = { ...required, monthlyBudgetUsd: 75 };
    expect(reconcileSettingsPatch(patch, {}, stored)).toEqual(patch);
    expect(reconcileSettingsPatch(patch, Object.create({ monthlyBudgetUsd: 10 }), stored)).toEqual(patch);
    expect(reconcileSettingsPatch(patch, undefined, stored)).toEqual(patch);
  });

  it('rejects a changed effort when the store changed the model it was chosen for', () => {
    const base = { ...required, effort: null };
    const previous = { ...stored, provider: 'openai' as const, model: 'gpt-5', effort: null };
    expect(reconcileSettingsPatch({ ...required, effort: 'high' }, base, previous)).toBeNull();
  });

  it('keeps a changed effort with the stored model when nothing else moved', () => {
    const base = { ...required, effort: null };
    const previous = { ...stored, effort: null };
    const result = reconcileSettingsPatch({ ...required, effort: 'high' }, base, previous);
    expect(result).toEqual({ ...required, effort: 'high' });
    expect(result?.provider).toBe(previous.provider);
    expect(result?.model).toBe(previous.model);
  });

  it('rejects a changed heavy effort when the store changed the heavy model', () => {
    const heavy = { heavyProvider: 'openai' as const, heavyModel: 'gpt-5', heavyEffort: null, heavyThresholdLines: 800 };
    const previous = { ...stored, ...heavy, heavyModel: 'gpt-6' };
    expect(reconcileSettingsPatch({ ...required, ...heavy, heavyEffort: 'high' }, { ...required, ...heavy }, previous)).toBeNull();
  });

  it('keeps a changed heavy effort with the stored heavy model when nothing else moved', () => {
    const heavy = { heavyProvider: 'openai' as const, heavyModel: 'gpt-5', heavyEffort: null, heavyThresholdLines: 800 };
    const previous = { ...stored, ...heavy };
    const result = reconcileSettingsPatch({ ...required, ...heavy, heavyEffort: 'high' }, { ...required, ...heavy }, previous);
    // The threshold is not part of the heavy group: the stored one is kept.
    expect(result).toEqual({ ...required, heavyProvider: 'openai', heavyModel: 'gpt-5', heavyEffort: 'high' });
    expect(result?.heavyProvider).toBe(previous.heavyProvider);
    expect(result?.heavyModel).toBe(previous.heavyModel);
  });

  it('rejects a changed field of a group when another field of the group moved in the store', () => {
    const base = { ...required, effort: null };
    const previous = { ...stored, model: 'gpt-5', effort: null };
    expect(reconcileSettingsPatch({ ...required, effort: 'high' }, base, previous)).toBeNull();
  });

  it('rejects a changed field of the heavy group when another field of the group moved in the store', () => {
    const heavy = { heavyProvider: 'openai' as const, heavyModel: 'gpt-5', heavyEffort: null, heavyThresholdLines: 800 };
    const previous = { ...stored, ...heavy, heavyProvider: 'anthropic' as const };
    expect(reconcileSettingsPatch({ ...required, ...heavy, heavyEffort: 'high' }, { ...required, ...heavy }, previous)).toBeNull();
  });

  it('writes the heavy threshold when the store changed the heavy model', () => {
    const heavy = { heavyProvider: 'openai' as const, heavyModel: 'gpt-5', heavyEffort: null, heavyThresholdLines: 800 };
    const previous = { ...stored, ...heavy, heavyModel: 'gpt-6' };
    const result = reconcileSettingsPatch({ ...required, ...heavy, heavyThresholdLines: 1000 }, { ...required, ...heavy }, previous);
    // The threshold sizes the diff, not the heavy model: it is written and the heavy model is not.
    expect(result).toEqual({ ...required, heavyThresholdLines: 1000 });
    expect(result).not.toHaveProperty('heavyModel');
  });

  it('rejects a heavy effort patch when the store changed the heavy model the patch left out', () => {
    const base = { ...required, heavyProvider: 'openai' as const, heavyModel: 'gpt-5', heavyEffort: null };
    const previous = { ...stored, heavyProvider: 'openai' as const, heavyModel: 'gpt-6', heavyEffort: null };
    // The patch changes the heavy effort only: the heavy model is not in the body.
    expect(reconcileSettingsPatch({ ...required, heavyEffort: 'high' }, base, previous)).toBeNull();
  });

  it('rejects an effort patch when the store changed the model the patch left out', () => {
    const base = { ...required, model: 'gpt-5', effort: null };
    const previous = { ...stored, model: 'gpt-6' };
    // The patch changes the effort only: the model is not in the body.
    expect(reconcileSettingsPatch(partialBody({ effort: 'high' }), base, previous)).toBeNull();
  });

  it('keeps a heavy effort patch when the heavy model the patch left out did not move', () => {
    const base = { ...required, heavyProvider: 'openai' as const, heavyModel: 'gpt-5', heavyEffort: null };
    const previous = { ...stored, heavyProvider: 'openai' as const, heavyModel: 'gpt-5', heavyEffort: null };
    const result = reconcileSettingsPatch({ ...required, heavyEffort: 'high' }, base, previous);
    // The heavy model is not in the patch: it keeps its stored value.
    expect(result).toEqual({ ...required, heavyEffort: 'high' });
    expect(result).not.toHaveProperty('heavyModel');
  });
});

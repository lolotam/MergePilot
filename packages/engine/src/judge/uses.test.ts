import { describe, expect, it } from 'vitest';
import { describeJudgeUses, hasJudgeUse, isJudgeUse, judgeUsesFromMode, legacyJudgeMode, normalizeJudgeUses } from './uses.js';

describe('judge uses', () => {
  it('maps the old single mode and keeps the duplicate check every mode had', () => {
    expect(judgeUsesFromMode('off')).toEqual(['dedupe']);
    expect(judgeUsesFromMode('annotate')).toEqual(['annotate', 'dedupe']);
    expect(judgeUsesFromMode('filter')).toEqual(['filter', 'dedupe']);
  });

  it('writes the closest old mode for the legacy column', () => {
    expect(legacyJudgeMode(['annotate', 'filter'])).toBe('filter');
    expect(legacyJudgeMode(new Set(['annotate', 'dedupe'] as const))).toBe('annotate');
    expect(legacyJudgeMode(['dedupe', 'consensus'])).toBe('off');
    expect(legacyJudgeMode([])).toBe('off');
  });

  it('normalizes, checks and describes a set of uses', () => {
    expect(normalizeJudgeUses(['consensus', 'dedupe', 'annotate', 'dedupe'])).toEqual(['annotate', 'dedupe', 'consensus']);
    expect(hasJudgeUse(new Set(['filter'] as const), 'filter')).toBe(true);
    expect(hasJudgeUse(['annotate'], 'filter')).toBe(false);
    expect(isJudgeUse('dedupe')).toBe(true);
    expect(isJudgeUse('off')).toBe(false);
    expect(describeJudgeUses(['dedupe', 'filter'])).toBe('filter, dedupe');
    expect(describeJudgeUses([])).toBe('none');
  });
});

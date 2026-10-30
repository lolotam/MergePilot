import { describe, expect, it } from 'vitest';
import { parseConfig, type MergePilotConfig } from '@mergepilot/engine';
import type { LoadRepoConfigResult } from '@mergepilot/github';
import { effectiveConfigFor } from './effective-config.js';
import type { MaxFindingsChoice } from '../core/types.js';

// The optional per-bot call timeout: an explicit number overrides `review.callTimeoutMs` for that
// bot only and joins the config hash's structured identity; null / undefined keeps the repo value.

const CHOICE = { provider: 'openai' as const, model: 'gpt-x', effort: null };
type RepoConfigResult = Extract<LoadRepoConfigResult, { config: MergePilotConfig }>;

/** What `loadRepoConfig` returns for this file, parsed with the worker's defaults. */
function repoFile(text: string, maxFindings?: MaxFindingsChoice, perReviewUsd?: number): RepoConfigResult {
  const parsed = parseConfig(text, { defaults: { ...CHOICE, maxFindings, perReviewUsd } });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return { configText: text, config: parsed.config, rulesFiles: [], ...(parsed.defaulted ? { defaulted: parsed.defaulted } : {}) };
}

const noFile = (): LoadRepoConfigResult => ({ missing: true });
const repoWithCallTimeout = (callTimeoutMs: number, review = ''): RepoConfigResult => repoFile(`review:\n  callTimeoutMs: ${callTimeoutMs}\n${review}`, 5);

const hashOf = (repo: LoadRepoConfigResult, overrides: { skillKey?: string; callTimeoutMs?: number | null | undefined } = {}): string =>
  effectiveConfigFor(repo, CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 }, overrides.skillKey, overrides.callTimeoutMs).configHash;

describe('effectiveConfigFor — the per-bot call timeout', () => {
  it('defaults the call timeout and the overall review timeout when no bot override exists', () => {
    const built = effectiveConfigFor(noFile(), CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 });
    expect(built.config.review.callTimeoutMs).toBe(300_000);
    expect(built.config.review.totalTimeoutMs).toBe(1_200_000);
  });

  it('lets a supplied bot call timeout override the default and keeps the overall review timeout', () => {
    const built = effectiveConfigFor(noFile(), CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 }, undefined, 600_000);
    expect(built.config.review.callTimeoutMs).toBe(600_000);
    expect(built.config.review.totalTimeoutMs).toBe(1_200_000);
  });

  it('keeps the repo call timeout when the bot override is omitted or null', () => {
    const repo = repoWithCallTimeout(450_000);
    expect(effectiveConfigFor(repo, CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 }).config.review.callTimeoutMs).toBe(450_000);
    expect(effectiveConfigFor(repo, CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 }, undefined, null).config.review.callTimeoutMs).toBe(450_000);
  });

  it('lets a bot override the repo call timeout while keeping the overall timeout and the other review settings', () => {
    const repo = repoWithCallTimeout(450_000, '  totalTimeoutMs: 900000\n  minSeverity: high\n');
    const overridden = effectiveConfigFor(repo, CHOICE, [], { language: 'en', minSeverity: undefined, maxFindings: 5 }, undefined, 600_000);
    expect(overridden.config.review.callTimeoutMs).toBe(600_000);
    expect(overridden.config.review.totalTimeoutMs).toBe(900_000);
    expect(overridden.config.review.minSeverity).toBe('high');
  });
});

describe('effectiveConfigFor — the per-bot call timeout in the config hash', () => {
  it('keeps the legacy hash when the override is omitted or null, with skill and inherited limits in play', () => {
    // These markers come from the unchanged implementation at b5432a1, before timeout overrides.
    expect(hashOf(noFile())).toBe('3eb14bd14121');
    expect(hashOf(noFile(), { callTimeoutMs: null })).toBe('3eb14bd14121');
    const repo = repoFile('review:\n  minSeverity: high\n', 20, 3);
    const inherited = hashOf(repo, { skillKey: 'a'.repeat(64) });
    expect(inherited).toBe('f0b9d19ebecb');
    expect(hashOf(repo, { skillKey: 'a'.repeat(64), callTimeoutMs: undefined })).toBe(inherited);
    expect(hashOf(repo, { skillKey: 'a'.repeat(64), callTimeoutMs: null })).toBe(inherited);
  });

  it('hashes an explicit bot call timeout as its own entry, apart from inheritance and from other values', () => {
    const repo = repoFile('review:\n  minSeverity: high\n', 20, 3);
    const inherited = hashOf(repo, { skillKey: 'a'.repeat(64) });
    const explicit600 = hashOf(repo, { skillKey: 'a'.repeat(64), callTimeoutMs: 600_000 });
    expect(explicit600).not.toBe(inherited);
    expect(explicit600).not.toBe(hashOf(repo, { skillKey: 'a'.repeat(64), callTimeoutMs: 900_000 }));
    expect(hashOf(repo, { skillKey: 'a'.repeat(64), callTimeoutMs: null })).toBe(inherited);
  });

  it('hashes an explicit call timeout equal to the default as an explicit change of identity', () => {
    const repo = repoFile('review:\n  minSeverity: high\n');
    expect(hashOf(repo, { callTimeoutMs: 300_000 })).not.toBe(hashOf(repo, {}));
  });

  it('keeps the skill part independent of the call timeout override', () => {
    const repo = repoFile('review:\n  minSeverity: high\n', 20, 3);
    expect(hashOf(repo, { skillKey: 'a'.repeat(64), callTimeoutMs: 600_000 })).not.toBe(hashOf(repo, { skillKey: 'b'.repeat(64), callTimeoutMs: 600_000 }));
  });

  it.each([
    { maxFindings: 20 as const, perReviewUsd: 3 },
    { maxFindings: 5 as const, perReviewUsd: 4 },
  ])('keeps other inherited settings in the identity with a timeout override (%j)', (settings) => {
    const built = (limits: { maxFindings: MaxFindingsChoice; perReviewUsd: number }) =>
      effectiveConfigFor(noFile(), CHOICE, [], { language: 'en', ...limits }, undefined, 600_000).configHash;
    expect(built(settings)).not.toBe(built({ maxFindings: 5, perReviewUsd: 3 }));
  });
});

describe('effectiveConfigFor — bot overrides stay independent', () => {
  it('does not leak one bot override into another bot or mutate the repo config', () => {
    const repo = repoWithCallTimeout(450_000);
    const botA = effectiveConfigFor(repo, CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 }, undefined, 600_000);
    const botB = effectiveConfigFor(repo, CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 });
    expect(botA.config.review.callTimeoutMs).toBe(600_000);
    expect(botB.config.review.callTimeoutMs).toBe(450_000);
    expect(repo.config.review.callTimeoutMs).toBe(450_000);
  });

  it('keeps the repository pricing handling unchanged when a bot overrides the call timeout', () => {
    const repo = repoFile('provider: openai\nmodel: gpt-x\nbudget:\n  pricing:\n    inputPerMTok: 1\n    outputPerMTok: 2\n', 5);
    const built = effectiveConfigFor(repo, CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 }, undefined, 600_000);
    expect(built.repoPricing).toMatchObject({ inputPerMTok: 1, outputPerMTok: 2 });
  });

  it('still throws on an invalid repository file', () => {
    expect(() => effectiveConfigFor({ errors: ['review.callTimeoutMs: expected int greater than 0'] }, CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings: 5 })).toThrow('Invalid .mergepilot.yml');
  });
});

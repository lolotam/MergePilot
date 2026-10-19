import { describe, expect, it } from 'vitest';
import { parseConfig } from '@mergepilot/engine';
import type { LoadRepoConfigResult } from '@mergepilot/github';
import type { MaxFindingsChoice } from '../core/types.js';
import { effectiveConfigFor, skillKeyOf } from './effective-config.js';

// The review marker's config hash covers the workspace findings limit wherever the review inherits
// it (ADR-0033), so changing the dashboard limit makes the next review a full one.

const CHOICE = { provider: 'openai' as const, model: 'gpt-x' };

/** What `loadRepoConfig` returns for this file, parsed with the worker's defaults. */
function repoFile(text: string, maxFindings: MaxFindingsChoice | undefined): LoadRepoConfigResult {
  const parsed = parseConfig(text, { defaults: { ...CHOICE, maxFindings } });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return { configText: text, config: parsed.config, rulesFiles: [], ...(parsed.defaulted ? { defaulted: parsed.defaulted } : {}) };
}

const effective = (repo: (limit: MaxFindingsChoice | undefined) => LoadRepoConfigResult, maxFindings?: MaxFindingsChoice) =>
  effectiveConfigFor(repo(maxFindings), CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings });

const noFile = (): LoadRepoConfigResult => ({ missing: true });
const fileWithoutLimit = (limit: MaxFindingsChoice | undefined) => repoFile('review:\n  minSeverity: high\n', limit);
const fileWithLimit = (limit: MaxFindingsChoice | undefined) => repoFile('review:\n  maxFindings: 3\n', limit);

describe('effectiveConfigFor — config hash and the workspace findings limit', () => {
  it.each([
    ['no repository file', noFile],
    ['a file without review.maxFindings', fileWithoutLimit],
  ])('with %s, a new workspace limit changes the hash and the default keeps the old one', (_name, repo) => {
    const atDefault = effective(repo, 5);
    expect(effective(repo).configHash).toBe(atDefault.configHash);
    const raised = effective(repo, 20);
    expect(raised.config.review.maxFindings).toBe(20);
    expect(raised.configHash).not.toBe(atDefault.configHash);
    expect(effective(repo, 50).configHash).not.toBe(raised.configHash);
  });

  it('keeps the hash of a file that names review.maxFindings whatever the workspace limit', () => {
    const hashes = new Set([undefined, 5, 20, 50].map((limit) => effective(fileWithLimit, limit as MaxFindingsChoice | undefined).configHash));
    expect(hashes.size).toBe(1);
    expect(effective(fileWithLimit, 50).config.review.maxFindings).toBe(3);
  });

  it('never hashes a file text like an inherited limit', () => {
    const text = 'review:\n  minSeverity: high\n';
    const inheriting = effective((limit) => repoFile(text, limit), 20);
    // A file that names no limit and inherits none, whose text is the inheriting file's text plus
    // a "\nmaxFindings=20" suffix: plain concatenation would hash both the same.
    const lookalike = effective(() => ({ ...repoFile(text, undefined), configText: `${text}\nmaxFindings=20` }));
    expect(lookalike.config.review.maxFindings).toBe(5);
    expect(lookalike.configHash).not.toBe(inheriting.configHash);
  });

  it('still uses the file pricing for the same model when only the limit was filled in', () => {
    const text = 'provider: openai\nmodel: gpt-x\nbudget:\n  pricing:\n    inputPerMTok: 1\n    outputPerMTok: 2\n';
    expect(effective((limit) => repoFile(text, limit), 20).repoPricing).toMatchObject({ inputPerMTok: 1, outputPerMTok: 2 });
  });
});

describe('effectiveConfigFor — config hash and the review skill (ADR-0034)', () => {
  const withSkill = (repo: (limit: MaxFindingsChoice | undefined) => LoadRepoConfigResult, skillKey?: string, maxFindings?: MaxFindingsChoice) =>
    effectiveConfigFor(repo(maxFindings), CHOICE, [], { language: 'en', minSeverity: 'medium', maxFindings }, skillKey);

  it.each([
    ['no repository file', noFile],
    ['a file without review.maxFindings', fileWithoutLimit],
    ['a file that names review.maxFindings', fileWithLimit],
  ])('with %s, Default keeps the old hash and a skill or a new skill text changes it', (_name, repo) => {
    const before = effective(repo).configHash;
    expect(withSkill(repo).configHash).toBe(before);
    const security = withSkill(repo, 'a'.repeat(64)).configHash;
    expect(security).not.toBe(before);
    expect(withSkill(repo, 'b'.repeat(64)).configHash).not.toBe(security);
    // A skill and an inherited limit both count, each on its own.
    expect(withSkill(repo, 'a'.repeat(64), 20).configHash).not.toBe(withSkill(repo, undefined, 20).configHash);
  });
});

describe('skillKeyOf', () => {
  const skill = (contentHash: string) => ({ contentHash });

  it("is a lone bot's own content hash, and undefined on Default", () => {
    expect(skillKeyOf([{ slot: 1 }])).toBeUndefined();
    expect(skillKeyOf([{ slot: 3, skill: skill('h3') }])).toBe('h3');
  });

  it("covers every bot of a consensus panel, so any bot's skill change makes the panel's next review full", () => {
    const panel = [{ slot: 1 }, { slot: 2, skill: skill('h2') }, { slot: 3 }];
    const key = skillKeyOf(panel);
    expect(key).toBe(JSON.stringify([{ slot: 2, skill: 'h2' }]));
    expect(skillKeyOf([{ slot: 1 }, { slot: 2, skill: skill('h2') }, { slot: 3, skill: skill('h3') }])).not.toBe(key);
    expect(skillKeyOf([{ slot: 1 }, { slot: 2 }])).toBeUndefined();
  });
});


describe('workspace per-review spending cap (ADR-0036)', () => {
  const resolve = (text: string | undefined, perReviewUsd?: number, maxFindings: MaxFindingsChoice = 5, skillKey?: string) => {
    let repo: LoadRepoConfigResult = { missing: true };
    if (text !== undefined) {
      const parsed = parseConfig(text, { defaults: { ...CHOICE, perReviewUsd, maxFindings } });
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
      repo = { configText: text, config: parsed.config, rulesFiles: [], defaulted: parsed.defaulted };
    }
    return effectiveConfigFor(repo, CHOICE, [], { language: 'en', perReviewUsd, maxFindings }, skillKey);
  };

  it.each([undefined, 'review:\n  minSeverity: high\n', 'budget:\n  maxInputTokens: 5000\n'])(
    'inherits the cap when omitted (%s), preserving old hashes only at the default', (text) => {
      const before = resolve(text);
      expect(resolve(text, 0.5).configHash).toBe(before.configHash);
      expect(resolve(text, 3).config.budget.perReviewUsd).toBe(3);
      expect(resolve(text, 3).configHash).not.toBe(before.configHash);
      expect(resolve(text, 4).configHash).not.toBe(resolve(text, 3).configHash);
      expect(resolve(text, 3, 20).configHash).not.toBe(resolve(text, 3).configHash);
      expect(resolve(text, 3, 20, 'skill').configHash).not.toBe(resolve(text, 3, 20).configHash);
    },
  );

  it('preserves the value and hash when the file names its own cap, even below the dashboard minimum', () => {
    const text = 'budget:\n  perReviewUsd: 0.2\n';
    expect(resolve(text, 3).config.budget.perReviewUsd).toBe(0.2);
    expect(resolve(text, 3).configHash).toBe(resolve(text, 10).configHash);
  });

  it('still accepts repository pricing when only the spending cap was inherited', () => {
    const text = 'provider: openai\nmodel: gpt-x\nbudget:\n  pricing:\n    inputPerMTok: 1\n    outputPerMTok: 2\n';
    expect(resolve(text, 3).repoPricing).toMatchObject({ inputPerMTok: 1, outputPerMTok: 2 });
  });
});

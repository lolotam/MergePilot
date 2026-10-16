import { describe, expect, it } from 'vitest';
import { parseConfig } from '@mergepilot/engine';
import type { LoadRepoConfigResult } from '@mergepilot/github';
import type { MaxFindingsChoice } from '../core/types.js';
import { effectiveConfigFor } from './effective-config.js';

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

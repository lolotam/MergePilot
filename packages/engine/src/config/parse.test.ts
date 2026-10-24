import { describe, expect, it } from 'vitest';
import { SeveritySchema } from '../review/types.js';
import { parseConfig } from './parse.js';

function expectErrors(text: string): string[] {
  const result = parseConfig(text);
  if (result.ok) throw new Error('expected parseConfig to fail');
  return result.errors;
}

describe('parseConfig', () => {
  it('fills every default for a minimal config', () => {
    const result = parseConfig('provider: anthropic\nmodel: claude-sonnet\n');

    expect(result).toEqual({
      ok: true,
      config: {
        provider: 'anthropic',
        model: 'claude-sonnet',
        fallback: [],
        language: 'ar',
        review: {
          maxFindings: 5,
          minSeverity: 'medium',
          exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap'],
          rulesFiles: ['CLAUDE.md', 'AGENTS.md'],
          maxRulesTokens: 12_000,
          contextTokens: 30_000,
          contextReads: 120,
          contextTokensPerFile: 0,
          prContextTokens: 15_000,
          pathInstructions: [],
          verify: true,
          libraryDocs: { source: 'npm', maxCharsPerLibrary: 8000, maxLibraries: 5 },
          maxPromptTokens: 90_000,
          batchTokens: 24_000,
          maxFileParts: 8,
          callTimeoutMs: 300_000,
          totalTimeoutMs: 1_200_000,
        },
        // Raised from 200,000 so huge PRs go to capped batches instead of being skipped (ADR-0013).
        budget: { perReviewUsd: 0.5, maxInputTokens: 1_000_000 },
        audit: {
          enabled: false,
          output: 'summary',
          maxFiles: 200,
          include: ['**/*'],
          exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'],
        },
      },
    });
  });

  it('accepts claude-code without a model', () => {
    const result = parseConfig('provider: claude-code\n');
    expect(result.ok).toBe(true);
  });

  it('requires a model for API providers', () => {
    expect(expectErrors('provider: anthropic\n')).toEqual([
      'model: required when provider is anthropic',
    ]);
  });

  it('rejects unknown keys with their path', () => {
    const errors = expectErrors('provider: openai\nmodel: gpt\nreview:\n  maxFinding: 3\n');
    expect(errors.some((e) => e.startsWith('review: ') && e.includes('maxFinding'))).toBe(true);
  });

  it.each([1, 50])('accepts maxFindings %i, the ends of 1..50', (maxFindings) => {
    const result = parseConfig(`provider: openai\nmodel: gpt\nreview:\n  maxFindings: ${maxFindings}\n`);
    expect(result.ok && result.config.review.maxFindings).toBe(maxFindings);
  });

  it.each([0, 51, 2.5])('rejects maxFindings %s with the key path', (maxFindings) => {
    const errors = expectErrors(`provider: openai\nmodel: gpt\nreview:\n  maxFindings: ${maxFindings}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^review\.maxFindings: /);
  });

  it.each(SeveritySchema.options)('accepts minSeverity %s', (severity) => {
    const result = parseConfig(
      `provider: gemini\nmodel: gemini-pro\nreview:\n  minSeverity: ${severity}\n`,
    );
    expect(result.ok && result.config.review.minSeverity).toBe(severity);
  });

  it('reports a missing provider for empty text', () => {
    expect(expectErrors('')).toEqual(['provider: required']);
    expect(expectErrors('   \n# only a comment\n')).toEqual(['provider: required']);
  });

  it('fills a missing provider and model from defaults (the SaaS App) and keeps the rest of the file', () => {
    const result = parseConfig('language: ar\nreview:\n  maxFindings: 5\n', { defaults: { provider: 'openai', model: 'gpt-x' } });
    expect(result.ok && [result.config.provider, result.config.model]).toEqual(['openai', 'gpt-x']);
    expect(result.ok && result.defaulted).toEqual(['provider', 'model']);
    expect(result.ok && result.config.review.maxFindings).toBe(5);
    expect(parseConfig('', { defaults: { provider: 'gemini', model: 'g' } }).ok).toBe(true);
  });

  it('fills each key on its own: a named provider without model, a model without provider', () => {
    const noModel = parseConfig('provider: anthropic\n', { defaults: { provider: 'openai', model: 'gpt-x' } });
    expect(noModel.ok && [noModel.config.provider, noModel.config.model, noModel.defaulted]).toEqual(['anthropic', 'gpt-x', ['model']]);
    const noProvider = parseConfig('model: gpt-4o\n', { defaults: { provider: 'openai', model: 'gpt-x' } });
    expect(noProvider.ok && [noProvider.config.provider, noProvider.config.model, noProvider.defaulted]).toEqual(['openai', 'gpt-4o', ['provider']]);
    const both = parseConfig('provider: gemini\nmodel: g\n', { defaults: { provider: 'openai', model: 'gpt-x' } });
    expect(both.ok && 'defaulted' in both).toBe(false);
  });

  it('never lets defaults replace a provider the file names, nor hide other errors', () => {
    const named = parseConfig('provider: claude-code\n', { defaults: { provider: 'openai', model: 'gpt-x' } });
    expect(named.ok && named.config.provider).toBe('claude-code');
    const bad = parseConfig('review:\n  maxFindings: 51\n', { defaults: { provider: 'openai', model: 'gpt-x', maxFindings: 20 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatch(/^review\.maxFindings: /);
  });

  it('fills review.maxFindings from defaults only when the file leaves it out (ADR-0033)', () => {
    const defaults = { provider: 'openai', model: 'gpt-x', maxFindings: 25 };
    const none = parseConfig('language: en\n', { defaults });
    expect(none.ok && none.config.review.maxFindings).toBe(25);
    expect(none.ok && none.defaulted).toEqual(['provider', 'model', 'maxFindings']);
    const otherKeys = parseConfig('review:\n  minSeverity: high\n', { defaults });
    expect(otherKeys.ok && [otherKeys.config.review.maxFindings, otherKeys.config.review.minSeverity]).toEqual([25, 'high']);
    const named = parseConfig('review:\n  maxFindings: 3\n', { defaults });
    expect(named.ok && named.config.review.maxFindings).toBe(3);
    expect(named.ok && named.defaulted).toEqual(['provider', 'model']);
    const noDefault = parseConfig('', { defaults: { provider: 'openai', model: 'gpt-x' } });
    expect(noDefault.ok && noDefault.config.review.maxFindings).toBe(5);
  });

  it('leaves a review value that is not a mapping for the schema to reject', () => {
    const filled = parseConfig('review: [1]\n', { defaults: { provider: 'openai', model: 'gpt-x', maxFindings: 10 } });
    expect(filled.ok).toBe(false);
    if (!filled.ok) expect(filled.errors[0]).toMatch(/^review: /);
  });

  it('returns a syntax error with a line number instead of throwing', () => {
    const errors = expectErrors('provider: openai\nmodel: [unclosed\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^YAML syntax error at line \d+/);
  });

  it('rejects a document that is not a mapping', () => {
    expect(expectErrors('- provider\n- openai\n')).toEqual([
      'config: must be a mapping of keys to values',
    ]);
  });

  it('keeps path instructions and audit schedule', () => {
    const result = parseConfig(
      [
        'provider: claude-code',
        'language: en',
        'review:',
        '  pathInstructions:',
        '    - path: "src/money/**"',
        '      instructions: "Never use floats for money."',
        'audit:',
        '  enabled: true',
        '  schedule: "0 3 * * 1"',
      ].join('\n'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.language).toBe('en');
    expect(result.config.review.pathInstructions).toEqual([
      { path: 'src/money/**', instructions: 'Never use floats for money.' },
    ]);
    expect(result.config.audit).toEqual({
      enabled: true,
      schedule: '0 3 * * 1',
      output: 'summary',
      maxFiles: 200,
      include: ['**/*'],
      exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'],
    });
  });

  it('parses budget.pricing and defaults cache prices to inputPerMTok', () => {
    const result = parseConfig(
      [
        'provider: anthropic',
        'model: claude-sonnet',
        'budget:',
        '  pricing:',
        '    inputPerMTok: 3.0',
        '    outputPerMTok: 15.0',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.budget.pricing).toEqual({
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
      cacheReadPerMTok: 3.0,
      cacheWritePerMTok: 3.0,
    });
  });

  it('accepts explicit cacheReadPerMTok and cacheWritePerMTok in budget.pricing', () => {
    const result = parseConfig(
      [
        'provider: anthropic',
        'model: claude-sonnet',
        'budget:',
        '  pricing:',
        '    inputPerMTok: 3.0',
        '    outputPerMTok: 15.0',
        '    cacheReadPerMTok: 0.3',
        '    cacheWritePerMTok: 3.75',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.budget.pricing).toEqual({
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    });
  });

  it('rejects negative pricing values', () => {
    const errors = expectErrors(
      [
        'provider: anthropic',
        'model: claude-sonnet',
        'budget:',
        '  pricing:',
        '    inputPerMTok: -1',
        '    outputPerMTok: 15.0',
      ].join('\n'),
    );
    expect(errors.some((e) => e.startsWith('budget.pricing.inputPerMTok'))).toBe(true);
  });

  it('rejects unknown pricing keys', () => {
    const errors = expectErrors(
      [
        'provider: anthropic',
        'model: claude-sonnet',
        'budget:',
        '  pricing:',
        '    inputPerMTok: 3.0',
        '    outputPerMTok: 15.0',
        '    unknownKey: 10',
      ].join('\n'),
    );
    expect(errors.some((e) => e.startsWith('budget.pricing') && e.includes('unknownKey'))).toBe(true);
  });

  it('requires outputPerMTok when pricing is provided', () => {
    const errors = expectErrors(
      [
        'provider: anthropic',
        'model: claude-sonnet',
        'budget:',
        '  pricing:',
        '    inputPerMTok: 3.0',
      ].join('\n'),
    );
    expect(errors.some((e) => e.startsWith('budget.pricing.outputPerMTok'))).toBe(true);
  });
});


describe('workspace perReviewUsd defaults', () => {
  const defaults = { provider: 'openai', model: 'gpt-x', perReviewUsd: 3 };
  it.each(['language: en\n', 'budget:\n  maxInputTokens: 5000\n'])('fills only an omitted cap (%s)', (text) => {
    const result = parseConfig(text, { defaults });
    expect(result.ok && result.config.budget.perReviewUsd).toBe(3);
    expect(result.ok && result.defaulted).toContain('perReviewUsd');
  });
  it('keeps an explicit cap and does not mark it inherited', () => {
    const result = parseConfig('budget:\n  perReviewUsd: 0.2\n', { defaults });
    expect(result.ok && result.config.budget.perReviewUsd).toBe(0.2);
    expect(result.ok && result.defaulted).not.toContain('perReviewUsd');
  });
  it.each(['budget: []', 'budget: null', 'budget: false', 'budget:\n  perReviewUsd: null', 'budget:\n  perReviewUsd: 0'])(
    'does not hide invalid repository values (%s)', (text) => {
      expect(parseConfig(text, { defaults }).ok).toBe(false);
    },
  );
});

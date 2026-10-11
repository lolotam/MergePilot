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
        language: 'ar',
        review: {
          maxFindings: 5,
          minSeverity: 'medium',
          exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap'],
          rulesFiles: ['CLAUDE.md', 'AGENTS.md'],
          pathInstructions: [],
          verify: true,
          libraryDocs: { source: 'npm', maxCharsPerLibrary: 8000, maxLibraries: 5 },
        },
        budget: { perReviewUsd: 0.5, maxInputTokens: 200000 },
        audit: { enabled: false },
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

  it('rejects maxFindings above 20 with the key path', () => {
    const errors = expectErrors('provider: openai\nmodel: gpt\nreview:\n  maxFindings: 21\n');
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
    expect(result.config.audit).toEqual({ enabled: true, schedule: '0 3 * * 1' });
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

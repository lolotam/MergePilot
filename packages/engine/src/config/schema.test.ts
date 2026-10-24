import { describe, expect, it } from 'vitest';
import { AuditSchema, MergePilotConfigSchema } from './schema.js';

describe('repository context limits', () => {
  const parse = (review = {}) => MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'm', review }).review;
  it('keeps the existing caps unless scaling or a batch override is configured', () => {
    expect(parse()).toMatchObject({ contextTokens: 30_000, contextReads: 120, contextTokensPerFile: 0, batchTokens: 24_000 });
    expect(parse().batchContextTokens).toBeUndefined();
    expect(parse({ contextReads: 1, batchContextTokens: 0, contextTokensPerFile: 0 }).contextReads).toBe(1);
    expect(parse({ contextReads: 500, batchContextTokens: 120_000, contextTokensPerFile: 4_000 }).contextReads).toBe(500);
  });
  it.each([
    { contextReads: 0 }, { contextReads: 501 }, { contextReads: 1.5 },
    { batchContextTokens: -1 }, { batchContextTokens: 1.5 },
    { contextTokensPerFile: -1 }, { contextTokensPerFile: 1.5 },
  ])('rejects invalid limits %o', (review) => {
    expect(() => parse(review)).toThrow();
  });
});

describe('the limits of the read-only exploration (ADR-0046)', () => {
  const parse = (review = {}) => MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'm', review }).review;

  it('defaults every exploration limit', () => {
    expect(parse().explore).toEqual({
      maxRounds: 3,
      maxRequestsPerRound: 8,
      maxReadTokens: 30_000,
      maxLinesPerRead: 400,
    });
  });

  it('rejects rounds outside the range', () => {
    expect(() => parse({ explore: { maxRounds: 0 } })).toThrow();
    expect(() => parse({ explore: { maxRounds: 4 } })).toThrow();
    expect(() => parse({ explore: { maxRequestsPerRound: 0 } })).toThrow();
    expect(() => parse({ explore: { maxRequestsPerRound: 9 } })).toThrow();
    expect(() => parse({ explore: { maxReadTokens: 999 } })).toThrow();
    expect(() => parse({ explore: { maxReadTokens: 200_001 } })).toThrow();
    expect(() => parse({ explore: { maxLinesPerRead: 19 } })).toThrow();
    expect(() => parse({ explore: { maxLinesPerRead: 2_001 } })).toThrow();
  });

  it('takes the approved bounds of the exploration limits', () => {
    expect(parse({ explore: { maxRounds: 3 } }).explore.maxRounds).toBe(3);
    expect(parse({ explore: { maxRequestsPerRound: 8 } }).explore.maxRequestsPerRound).toBe(8);
  });
});

describe('AuditSchema', () => {
  it('applies defaults correctly', () => {
    const parsed = AuditSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      output: 'summary',
      maxFiles: 200,
      include: ['**/*'],
      exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'],
    });
  });

  it('accepts valid custom values', () => {
    const parsed = AuditSchema.parse({
      enabled: true,
      schedule: '0 3 * * 1',
      output: 'issue',
      maxFiles: 100,
      include: ['src/**', 'lib/**'],
      exclude: ['**/test/**'],
    });
    expect(parsed).toEqual({
      enabled: true,
      schedule: '0 3 * * 1',
      output: 'issue',
      maxFiles: 100,
      include: ['src/**', 'lib/**'],
      exclude: ['**/test/**'],
    });
  });

  it('rejects invalid output', () => {
    expect(() => AuditSchema.parse({ output: 'email' })).toThrow();
  });

  it('rejects non-positive maxFiles', () => {
    expect(() => AuditSchema.parse({ maxFiles: 0 })).toThrow();
    expect(() => AuditSchema.parse({ maxFiles: -5 })).toThrow();
  });

  it('is integrated in MergePilotConfigSchema', () => {
    const config = MergePilotConfigSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
    expect(config.audit).toEqual({
      enabled: false,
      output: 'summary',
      maxFiles: 200,
      include: ['**/*'],
      exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'],
    });
  });
});

describe('FallbackEntrySchema & MergePilotConfigSchema (ADR-0008)', () => {
  it('accepts valid fallback entries with effort and baseUrl', () => {
    const config = MergePilotConfigSchema.parse({
      provider: 'openai',
      model: 'gpt-5',
      effort: 'high',
      fallback: [
        { provider: 'xai', model: 'grok-4', effort: 'medium' },
        { provider: 'custom', model: 'local-model', baseUrl: 'http://localhost:11434/v1' },
      ],
    });
    expect(config.effort).toBe('high');
    expect(config.fallback).toEqual([
      { provider: 'xai', model: 'grok-4', effort: 'medium' },
      { provider: 'custom', model: 'local-model', baseUrl: 'http://localhost:11434/v1' },
    ]);
  });

  it('rejects baseUrl on a preset fallback entry (a key must never go to a repo-chosen URL)', () => {
    expect(() =>
      MergePilotConfigSchema.parse({
        provider: 'openai',
        model: 'gpt-5',
        fallback: [{ provider: 'xai', model: 'grok-4', baseUrl: 'https://evil.example/v1' }],
      }),
    ).toThrow('baseUrl is not allowed here');
  });

  it('accepts a custom fallback without baseUrl (the URL comes from a trusted source)', () => {
    const config = MergePilotConfigSchema.parse({
      provider: 'openai',
      model: 'gpt-5',
      fallback: [{ provider: 'custom', model: 'local-model' }],
    });
    expect(config.fallback).toEqual([{ provider: 'custom', model: 'local-model' }]);
  });

  it('rejects more than 3 fallback models (MAX_FALLBACK_MODELS = 3)', () => {
    expect(() =>
      MergePilotConfigSchema.parse({
        provider: 'openai',
        model: 'gpt-5',
        fallback: [
          { provider: 'xai', model: 'grok-4' },
          { provider: 'deepseek', model: 'deepseek-chat' },
          { provider: 'openrouter', model: 'openai/gpt-5' },
          { provider: 'nvidia', model: 'nvidia/nemotron' },
        ],
      }),
    ).toThrow();
  });

  it('rejects baseUrl for a preset provider such as openrouter', () => {
    const result = MergePilotConfigSchema.safeParse({
      provider: 'openrouter',
      model: 'openai/gpt-5',
      baseUrl: 'https://evil.example/v1',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['baseUrl']);
    expect(result.error?.issues[0]?.message).toMatch(/preset providers always use their fixed API URL/);
  });

  it('accepts custom without baseUrl, and tolerates (but never uses) a file baseUrl for custom', () => {
    expect(MergePilotConfigSchema.parse({ provider: 'custom', model: 'local-model' }).provider).toBe('custom');

    const validCustom = MergePilotConfigSchema.parse({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(validCustom.baseUrl).toBe('http://localhost:8000/v1');
  });

  it('accepts all compatible provider presets', () => {
    const presets = [
      'xai',
      'deepseek',
      'nvidia',
      'openrouter',
      'opencode-zen',
      'opencode-go',
      'zai',
      'zai-coding',
    ] as const;
    for (const p of presets) {
      const parsed = MergePilotConfigSchema.parse({ provider: p, model: 'test-model' });
      expect(parsed.provider).toBe(p);
    }
  });
});


describe('review limits for huge PRs (ADR-0013)', () => {
  it('defaults maxPromptTokens, batchTokens, callTimeoutMs and totalTimeoutMs', () => {
    const config = MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'claude-sonnet' });
    expect(config.review).toMatchObject({
      maxPromptTokens: 90_000,
      batchTokens: 24_000,
      callTimeoutMs: 300_000,
      totalTimeoutMs: 1_200_000,
    });
  });

  it('accepts custom limits and rejects non-positive ones', () => {
    const config = MergePilotConfigSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet',
      review: { maxPromptTokens: 30_000, batchTokens: 10_000, callTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
    });
    expect(config.review.batchTokens).toBe(10_000);
    expect(config.review.totalTimeoutMs).toBe(600_000);
    expect(() =>
      MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'm', review: { callTimeoutMs: 0 } }),
    ).toThrow();
    expect(() =>
      MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'm', review: { batchTokens: -1 } }),
    ).toThrow();
  });
});

describe('the parts a big file is split into (ADR-0045)', () => {
  const parse = (review = {}) => MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'm', review }).review;

  it('defaults to 8 parts and takes the range 1 to 50', () => {
    expect(parse().maxFileParts).toBe(8);
    expect(parse({ maxFileParts: 1 }).maxFileParts).toBe(1);
    expect(parse({ maxFileParts: 50 }).maxFileParts).toBe(50);
  });

  it('rejects a number of parts outside the range', () => {
    expect(() => parse({ maxFileParts: 0 })).toThrow();
    expect(() => parse({ maxFileParts: 51 })).toThrow();
    expect(() => parse({ maxFileParts: 1.5 })).toThrow();
  });
});

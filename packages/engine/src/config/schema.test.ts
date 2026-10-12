import { describe, expect, it } from 'vitest';
import { AuditSchema, MergePilotConfigSchema } from './schema.js';

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

  it('rejects custom provider in fallback without baseUrl', () => {
    expect(() =>
      MergePilotConfigSchema.parse({
        provider: 'openai',
        model: 'gpt-5',
        fallback: [{ provider: 'custom', model: 'local-model' }],
      }),
    ).toThrow('required when provider is custom');
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

  it('requires baseUrl when root provider is custom', () => {
    expect(() =>
      MergePilotConfigSchema.parse({
        provider: 'custom',
        model: 'local-model',
      }),
    ).toThrow('required when provider is custom');

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


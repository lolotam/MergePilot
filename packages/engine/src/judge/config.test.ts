import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/parse.js';
import { judgeChainOf, JudgeConfigSchema } from './config.js';
import { isApiProviderId } from '../providers/ids.js';
import { isJudgeKeyOnlyProviderId, JUDGE_KEY_ONLY_PROVIDER_IDS, JUDGE_PROVIDER_IDS, jevModelIds, systemOneUrl } from './providers.js';

describe('judge config', () => {
  it('defaults the model, the duplicate check only (the old mode off) and threshold 0.35', () => {
    const judge = JudgeConfigSchema.parse({ provider: 'typesafe' });
    expect(judge).toEqual({ provider: 'typesafe', uses: ['dedupe'], threshold: 0.35, fallback: [] });
    expect(judgeChainOf(judge)).toEqual([{ provider: 'typesafe', model: 'jev-latest' }]);
  });

  it('takes uses as a set, maps the old mode, and lets uses win over mode', () => {
    const usesOf = (judge: Record<string, unknown>) => JudgeConfigSchema.parse({ provider: 'typesafe', ...judge }).uses;
    expect(usesOf({ uses: ['dedupe', 'annotate', 'filter', 'annotate'] })).toEqual(['annotate', 'filter', 'dedupe']);
    expect(usesOf({ uses: [] })).toEqual([]);
    expect(usesOf({ uses: ['consensus'] })).toEqual(['consensus']);
    expect(usesOf({ mode: 'off' })).toEqual(['dedupe']);
    expect(usesOf({ mode: 'annotate' })).toEqual(['annotate', 'dedupe']);
    expect(usesOf({ mode: 'filter' })).toEqual(['filter', 'dedupe']);
    expect(usesOf({ mode: 'filter', uses: ['annotate'] })).toEqual(['annotate']);
    expect(JudgeConfigSchema.safeParse({ provider: 'typesafe', uses: ['loud'] }).success).toBe(false);
    expect(JudgeConfigSchema.safeParse({ provider: 'typesafe', mode: 'dedupe' }).success).toBe(false);
  });

  it('accepts only Jev models for each provider', () => {
    for (const provider of JUDGE_PROVIDER_IDS) {
      for (const model of jevModelIds(provider)) {
        expect(JudgeConfigSchema.safeParse({ provider, model }).success).toBe(true);
      }
    }
    expect(JudgeConfigSchema.safeParse({ provider: 'openrouter', model: 'openai/gpt-5' }).success).toBe(false);
    expect(JudgeConfigSchema.safeParse({ provider: 'typesafe', fallback: [{ provider: 'opencode-zen', model: 'glm-5' }] }).success).toBe(false);
  });

  it('keeps Vercel AI Gateway on Jev only for the judge, though it is also a review provider now', () => {
    expect(jevModelIds('vercel-gateway')).toEqual(['typesafe-ai/jev']);
    expect(systemOneUrl('vercel-gateway')).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(JUDGE_KEY_ONLY_PROVIDER_IDS).toEqual(['typesafe']);
    expect(isJudgeKeyOnlyProviderId('vercel-gateway')).toBe(false);
    expect(isApiProviderId('vercel-gateway')).toBe(true);
    expect(JudgeConfigSchema.safeParse({ provider: 'vercel-gateway', model: 'anthropic/claude-sonnet-4.5' }).success).toBe(false);
  });

  it('takes at most three fallbacks and rejects a baseUrl', () => {
    const entry = { provider: 'opencode-zen' };
    expect(JudgeConfigSchema.safeParse({ provider: 'typesafe', fallback: [entry, entry, entry] }).success).toBe(true);
    expect(JudgeConfigSchema.safeParse({ provider: 'typesafe', fallback: [entry, entry, entry, entry] }).success).toBe(false);
    expect(JudgeConfigSchema.safeParse({ provider: 'typesafe', baseUrl: 'https://x.example' }).success).toBe(false);
  });

  it('still parses an old .mergepilot.yml judge section with mode', () => {
    const result = parseConfig(['provider: anthropic', 'model: claude-sonnet-5-5', 'judge:', '  provider: typesafe', '  mode: annotate'].join('\n'));
    expect(result.ok && result.config.judge?.uses).toEqual(['annotate', 'dedupe']);
  });

  it('parses a judge section in .mergepilot.yml', () => {
    const result = parseConfig(
      [
        'provider: anthropic',
        'model: claude-sonnet-5-5',
        'judge:',
        '  provider: openrouter',
        '  mode: filter',
        '  uses: [annotate, filter, dedupe]',
        '  threshold: 0.4',
        '  fallback:',
        '    - provider: opencode-zen',
        '      model: jev-1.13-free',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.judge?.uses).toEqual(['annotate', 'filter', 'dedupe']);
      expect(judgeChainOf(result.config.judge!)).toEqual([
        { provider: 'openrouter', model: '~typesafe/jev-latest' },
        { provider: 'opencode-zen', model: 'jev-1.13-free' },
      ]);
    }
  });
});

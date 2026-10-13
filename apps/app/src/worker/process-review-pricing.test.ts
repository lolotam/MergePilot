import { describe, expect, it, vi } from 'vitest';
import type { PriceEntry } from '@mergepilot/engine';
import type { JudgeSettings } from '../core/types.js';
import { createHarness, type HarnessOptions } from './model-settings.fixtures.js';
import { processReviewJob } from './process-review.js';

const FETCHED = new Date('2026-10-13T02:30:00.000Z');
// The harness model reports 50 input and 20 output tokens.
const catalogEntry: PriceEntry = { provider: 'anthropic', model: 'claude-3-5-sonnet', inputPerMTok: 3, outputPerMTok: 15, source: 'models.dev' };

async function review(options: Partial<HarnessOptions> & { catalog?: PriceEntry[] }) {
  const h = createHarness({ settings: {}, ...options });
  if (options.catalog) await h.store.replaceModelPrices('models.dev', options.catalog, FETCHED);
  const result = await processReviewJob(h.job, h.deps);
  return { ...h, result, run: await h.latestRun(), config: h.getCapturedConfig() };
}

const repoFile = (provider: string, model: string) => `
provider: ${provider}
model: ${model}
budget:
  pricing:
    inputPerMTok: 10
    outputPerMTok: 20
`;

describe('processReviewJob — automatic model prices (ADR-0016)', () => {
  it('prices the run from the catalog: budget.pricing, cost and result.pricing', async () => {
    const { result, run, config } = await review({ catalog: [catalogEntry] });
    expect(result.status).toBe('completed');
    expect(config?.budget.pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 3, cacheWritePerMTok: 3 });
    expect(run?.costUsd).toBeCloseTo((50 * 3 + 20 * 15) / 1_000_000, 9);
    expect(run?.result?.pricing).toEqual({
      source: 'catalog:models.dev',
      inputPerMTok: 3,
      outputPerMTok: 15,
      fetchedAt: FETCHED.toISOString(),
    });
  });

  it('uses the workspace override before the repo file and the catalog', async () => {
    const { run, config } = await review({
      catalog: [catalogEntry],
      settings: { priceOverrides: [{ provider: 'anthropic', model: 'claude-3-5-sonnet', inputPerMTok: 1, outputPerMTok: 2 }] },
      repoFiles: { '.mergepilot.yml': repoFile('anthropic', 'claude-3-5-sonnet') },
    });
    expect(config?.budget.pricing).toMatchObject({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(run?.result?.pricing).toEqual({ source: 'override', inputPerMTok: 1, outputPerMTok: 2 });
    expect(run?.costUsd).toBeCloseTo((50 * 1 + 20 * 2) / 1_000_000, 9);
  });

  it('uses the repo pricing for the same model before the catalog, and ignores it for another model', async () => {
    const same = await review({ catalog: [catalogEntry], repoFiles: { '.mergepilot.yml': repoFile('anthropic', 'claude-3-5-sonnet') } });
    expect(same.run?.result?.pricing).toEqual({ source: 'repo', inputPerMTok: 10, outputPerMTok: 20 });

    const other = await review({ catalog: [catalogEntry], repoFiles: { '.mergepilot.yml': repoFile('openai', 'gpt-x') } });
    expect(other.run?.result?.pricing?.source).toBe('catalog:models.dev');
  });

  it('leaves the cost null (never $0) when no source prices the model', async () => {
    const { run, config } = await review({ settings: { provider: 'xai', model: 'grok-unpriced' } });
    expect(config?.budget.pricing).toBeUndefined();
    expect(run?.costUsd).toBeNull();
    expect(run?.result?.pricing).toEqual({ source: 'unknown', inputPerMTok: null, outputPerMTok: null });
  });

  it('now applies the per-review budget preflight: an expensive known price skips the review', async () => {
    const generate = vi.fn();
    const { result, run } = await review({
      catalog: [{ ...catalogEntry, inputPerMTok: 1000, outputPerMTok: 1000 }],
      fakeModel: { label: 'expensive', generate },
    });
    expect(result.status).toBe('skipped');
    expect(run?.detail ?? '').toContain('estimated');
    expect(generate).not.toHaveBeenCalled();
  });

  it('prices the heavy-duty model when it reviews the PR', async () => {
    const { config, run } = await review({
      catalog: [catalogEntry, { provider: 'openai', model: 'gpt-heavy', inputPerMTok: 5, outputPerMTok: 25, source: 'models.dev' }],
      settings: { heavyProvider: 'openai', heavyModel: 'gpt-heavy', heavyThresholdLines: 10 },
      additions: 500,
    });
    expect(config?.model).toBe('gpt-heavy');
    expect(run?.result?.pricing).toMatchObject({ source: 'catalog:models.dev', inputPerMTok: 5 });
  });

  it('prices the judge from the catalog before its static table', async () => {
    const judge: JudgeSettings = { enabled: true, provider: 'opencode-zen', model: 'jev-1.13', mode: 'annotate', threshold: 0.35, fallback: [] };
    const finding = { path: 'src/main.ts', line: 2, side: 'RIGHT', title: 'Bug', body: 'Bug body', severity: 'medium', category: 'correctness', evidence: 'b', confidence: 0.9 };
    const fakeModel = {
      label: 'test-model',
      generate: vi.fn(async () => ({
        text: JSON.stringify({ summary: 'One issue', findings: [finding] }),
        finishReason: 'stop' as const,
        usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })),
    };
    const h = createHarness({ settings: { judge, minSeverity: 'low' }, fakeModel });
    await h.store.replaceModelPrices(
      'models.dev',
      [catalogEntry, { provider: 'opencode-zen', model: 'jev-1.13', inputPerMTok: 0.5, outputPerMTok: 0, source: 'models.dev' }],
      FETCHED,
    );
    h.deps.judgeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.9 }]));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 1000, output_tokens: 0 } }));
    });
    await processReviewJob(h.job, h.deps);
    const run = await h.latestRun();
    expect(run?.result?.judge?.costUsd).toBeCloseTo((1000 * 0.5) / 1_000_000, 12);
  });
});

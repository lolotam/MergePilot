import { describe, expect, it, vi } from 'vitest';
import type { PriceEntry, ReviewModel } from '@mergepilot/engine';
import type { JudgeSettings } from '../core/types.js';
import { createHarness, WORKSPACE_ID, type HarnessOptions } from './model-settings.fixtures.js';
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
    const judge: JudgeSettings = { enabled: true, provider: 'opencode-zen', model: 'jev-1.13', uses: ['annotate', 'dedupe'], threshold: 0.35, fallback: [] };
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

describe('processReviewJob — API-equivalent cost of subscription and token-plan runs (ADR-0024)', () => {
  const answer = (findings: unknown[] = []) =>
    vi.fn(async () => ({
      text: JSON.stringify({ summary: 'LGTM', findings }),
      finishReason: 'stop' as const,
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
  const subscribed = (findings: unknown[] = []): ReviewModel => ({ label: 'anthropic:claude-3-5-sonnet', includedInSubscription: true, generate: answer(findings) });
  const monthStart = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); };

  it('keeps a subscription run at $0, records what its tokens would cost at the API price, and leaves the monthly spend at $0', async () => {
    const { run, store } = await review({ catalog: [catalogEntry], fakeModel: subscribed() });

    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toMatchObject({ source: 'subscription', inputPerMTok: 0, outputPerMTok: 0, apiEquivalentSource: 'catalog:models.dev' });
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo((50 * 3 + 20 * 15) / 1_000_000, 9);
    expect(await store.monthCostUsd(WORKSPACE_ID, monthStart())).toBe(0);
  });

  it('shows no equivalent at all (never $0) when the API price of the subscription model is unknown', async () => {
    const { run } = await review({ fakeModel: subscribed() });

    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toEqual({ source: 'subscription', inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('prices a $0 token-plan run as the same model on the plain API provider', async () => {
    const { run } = await review({
      settings: { provider: 'zai-coding', model: 'glm-5.3' },
      catalog: [
        { provider: 'zai-coding', model: 'glm-5.3', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
        { provider: 'zai', model: 'glm-5.3', inputPerMTok: 1.4, outputPerMTok: 4.4, source: 'models.dev' },
      ],
    });

    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toMatchObject({ source: 'catalog:models.dev', inputPerMTok: 0, outputPerMTok: 0, apiEquivalentSource: 'catalog:models.dev' });
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo((50 * 1.4 + 20 * 4.4) / 1_000_000, 9);
  });

  it('prices a MiniMax Coding Plan run as the same model on the plain MiniMax provider', async () => {
    const { run } = await review({
      settings: { provider: 'minimax-coding-plan', model: 'MiniMax-M3.1-Flash' },
      catalog: [
        { provider: 'minimax-coding-plan', model: 'MiniMax-M3.1-Flash', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
        { provider: 'minimax', model: 'MiniMax-M3.1-Flash', inputPerMTok: 0.15, outputPerMTok: 0.6, source: 'models.dev' },
      ],
    });

    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toMatchObject({ source: 'catalog:models.dev', inputPerMTok: 0, outputPerMTok: 0, apiEquivalentSource: 'catalog:models.dev' });
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo((50 * 0.15 + 20 * 0.6) / 1_000_000, 9);
  });

  it("computes the equivalent from the model's own usage, not the judge's tokens added to the run", async () => {
    const judge: JudgeSettings = { enabled: true, provider: 'opencode-zen', model: 'jev-1.13', uses: ['annotate', 'dedupe'], threshold: 0.35, fallback: [] };
    const finding = { path: 'src/main.ts', line: 2, side: 'RIGHT', title: 'Bug', body: 'Bug body', severity: 'medium', category: 'correctness', evidence: 'b', confidence: 0.9 };
    const model = subscribed([finding]);
    const h = createHarness({ settings: { judge, minSeverity: 'low' }, fakeModel: model });
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

    // Every call of the review model (the review and its verify pass) is 50 in / 20 out; the judge's
    // 1,000 input tokens are in the stored usage but not in the equivalent.
    const calls = vi.mocked(model.generate).mock.calls.length;
    expect(run?.result?.usage?.inputTokens).toBe(calls * 50 + 1000);
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo((calls * 50 * 3 + calls * 20 * 15) / 1_000_000, 9);
    expect(run?.costUsd).toBeCloseTo((1000 * 0.5) / 1_000_000, 12);
  });
  it("never takes the subscription's equivalent from the repository's budget.pricing", async () => {
    const { run } = await review({
      catalog: [catalogEntry],
      repoFiles: { '.mergepilot.yml': repoFile('anthropic', 'claude-3-5-sonnet') },
      fakeModel: subscribed(),
    });

    expect(run?.result?.pricing).toMatchObject({ source: 'subscription', apiEquivalentSource: 'catalog:models.dev' });
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo((50 * 3 + 20 * 15) / 1_000_000, 9);
  });

  it('gives an unpriced token-plan run no equivalent, even when the plain API price is known', async () => {
    const { run } = await review({
      settings: { provider: 'zai-coding', model: 'glm-5.3' },
      catalog: [{ provider: 'zai', model: 'glm-5.3', inputPerMTok: 1.4, outputPerMTok: 4.4, source: 'models.dev' }],
    });

    expect(run?.costUsd).toBeNull();
    expect(run?.result?.pricing).toEqual({ source: 'unknown', inputPerMTok: null, outputPerMTok: null });
  });

  it('grants no equivalent to a plan whose catalog price is not $0, nor to an unpriced plan given a zero-rate manual price', async () => {
    const zaiRow: PriceEntry = { provider: 'zai', model: 'glm-5.3', inputPerMTok: 1.4, outputPerMTok: 4.4, source: 'models.dev' };

    const priced = await review({
      settings: { provider: 'zai-coding', model: 'glm-5.3' },
      catalog: [{ provider: 'zai-coding', model: 'glm-5.3', inputPerMTok: 0.5, outputPerMTok: 1, source: 'models.dev' }, zaiRow],
    });
    expect(priced.run?.costUsd).toBeCloseTo((50 * 0.5 + 20 * 1) / 1_000_000, 9);
    expect(priced.run?.result?.pricing?.apiEquivalentUsd).toBeUndefined();

    const zeroOverride = await review({
      settings: { provider: 'zai-coding', model: 'glm-5.3', priceOverrides: [{ provider: 'zai-coding', model: 'glm-5.3', inputPerMTok: 0, outputPerMTok: 0 }] },
      catalog: [zaiRow],
    });
    expect(zeroOverride.run?.result?.pricing).toEqual({ source: 'override', inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('completes a subscription run without an equivalent when its price lookup fails', async () => {
    // Once the bot's model is built, the run's only getModelPrice call is the equivalent's (the
    // config is priced before, the judge's prices come from listModelPrices): fail just that key,
    // and check it was hit exactly once.
    const h = createHarness({ settings: {}, fakeModel: subscribed() });
    await h.store.replaceModelPrices('models.dev', [catalogEntry], FETCHED);
    const real = h.store.getModelPrice.bind(h.store);
    const buildModel = h.deps.createModelForProvider!;
    let modelBuilt = false;
    h.deps.createModelForProvider = async (...args) => {
      const built = await buildModel(...args);
      modelBuilt = true;
      return built;
    };
    let failures = 0;
    vi.spyOn(h.store, 'getModelPrice').mockImplementation(async (provider, model) => {
      if (modelBuilt && provider === catalogEntry.provider && model === catalogEntry.model) {
        failures += 1;
        throw new Error('price store down');
      }
      return real(provider, model);
    });

    const result = await processReviewJob(h.job, h.deps);
    const run = await h.latestRun();

    expect(failures).toBe(1);
    expect(result.status).toBe('completed');
    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toEqual({ source: 'subscription', inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('completes a token-plan run without an equivalent when its price lookup fails', async () => {
    // A token plan's equivalent is the only lookup of the plain `zai` provider in a run, so only it fails.
    const h = createHarness({ settings: { provider: 'zai-coding', model: 'glm-5.3' } });
    await h.store.replaceModelPrices(
      'models.dev',
      [
        { provider: 'zai-coding', model: 'glm-5.3', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
        { provider: 'zai', model: 'glm-5.3', inputPerMTok: 1.4, outputPerMTok: 4.4, source: 'models.dev' },
      ],
      FETCHED,
    );
    const real = h.store.getModelPrice.bind(h.store);
    vi.spyOn(h.store, 'getModelPrice').mockImplementation(async (provider, model) => {
      if (provider === 'zai') throw new Error('price store down');
      return real(provider, model);
    });

    const result = await processReviewJob(h.job, h.deps);
    const run = await h.latestRun();

    expect(result.status).toBe('completed');
    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toEqual({ source: 'catalog:models.dev', inputPerMTok: 0, outputPerMTok: 0, fetchedAt: FETCHED.toISOString() });
  });
});

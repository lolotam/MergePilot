import { describe, expect, it, vi } from 'vitest';
import { LlmFailure, type LlmFailureCode, type PriceEntry, type ReviewModel } from '@mergepilot/engine';
import { BudgetAdmission } from './budget-admission.js';
import type { DualAuthState } from '../credentials/dual-auth.js';
import { createHarness, WORKSPACE_ID } from './model-settings.fixtures.js';
import { processReviewJob } from './process-review.js';

// ADR-0027 Phase B, end to end through the worker: anthropic has a subscription (the default)
// and API keys, and the model chain is [subscription, the same model on the keys].

const LABEL = 'anthropic:claude-3-5-sonnet';
const catalog: PriceEntry = { provider: 'anthropic', model: 'claude-3-5-sonnet', inputPerMTok: 3, outputPerMTok: 15, source: 'models.dev' };
const usage = { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = () => vi.fn(async () => ({ text: JSON.stringify({ summary: 'LGTM', findings: [] }), finishReason: 'stop' as const, usage }));
const failWith = (code: LlmFailureCode) =>
  vi.fn(async () => {
    throw new LlmFailure({ code, provider: 'anthropic', message: `${code} from anthropic` });
  });

function chain(primary: ReturnType<typeof vi.fn>, keys: ReturnType<typeof vi.fn>): ReviewModel {
  return {
    label: LABEL,
    authMethod: 'subscription',
    includedInSubscription: true,
    generate: primary,
    fallbacks: [{ label: LABEL, authMethod: 'api-key', fallbackTriggers: ['quota', 'rate-limit'], generate: keys }],
  };
}

const bothMethods: DualAuthState = { hasSubscription: true, hasApiKeys: true, preference: 'subscription', effective: 'subscription' };
const subscriptionOnly: DualAuthState = { ...bothMethods, hasApiKeys: false };

async function dualReview(model: ReviewModel, options: { repoFiles?: Record<string, string>; state?: DualAuthState; monthlyBudgetUsd?: number } = {}) {
  const h = createHarness({
    settings: { monthlyBudgetUsd: options.monthlyBudgetUsd ?? null },
    fakeModel: model,
    ...(options.repoFiles ? { repoFiles: options.repoFiles } : {}),
  });
  await h.store.replaceModelPrices('models.dev', [catalog], new Date('2026-10-13T02:30:00.000Z'));
  const state = options.state ?? bothMethods;
  const credentials = {
    ...h.credentials,
    getEffectiveAuthMethod: vi.fn(async () => state.effective),
    getDualAuthState: vi.fn(async () => state),
  };
  const admission = new BudgetAdmission();
  const admit = vi.spyOn(admission, 'admit');
  const result = await processReviewJob(h.job, { ...h.deps, credentials, budgetAdmission: admission });
  return { ...h, result, admit, run: await h.latestRun(), config: h.getCapturedConfig() };
}

describe('processReviewJob — method fallback from a subscription to API keys (ADR-0027)', () => {
  it('records the switch, prices the paid calls at the trusted API price and counts them in the month', async () => {
    const keys = answer();
    const repoPricing = `provider: anthropic\nmodel: claude-3-5-sonnet\nbudget:\n  pricing:\n    inputPerMTok: 0\n    outputPerMTok: 0\n`;
    const { run, config, store, reviews } = await dualReview(chain(failWith('RATE_LIMIT'), keys), { repoFiles: { '.mergepilot.yml': repoPricing } });

    expect(keys).toHaveBeenCalledTimes(1);
    // The repository's $0 price is ignored for a dual provider: the catalog prices the keys.
    expect(config?.budget.pricing).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(run?.costUsd).toBeCloseTo((50 * 3 + 20 * 15) / 1_000_000, 12);
    expect(await store.monthCostUsd(WORKSPACE_ID, new Date(Date.UTC(2000, 0, 1)))).toBeGreaterThan(0);
    expect(run?.result).toMatchObject({ fallbackFromMethod: 'subscription', modelUsedMethod: 'api-key' });
    expect(run?.result?.pricing).toMatchObject({ source: 'catalog:models.dev' });
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeUndefined();
    // The configured model still answered: the run keeps it, with the switch disclosed.
    expect(run).toMatchObject({ provider: 'anthropic', model: 'claude-3-5-sonnet', fallbackFrom: LABEL });
    expect(reviews[0]?.body).toContain('continued on `anthropic:claude-3-5-sonnet` with an API key');
  });

  it('never pays with the keys when the subscription fails authentication', async () => {
    const keys = answer();
    const { run } = await dualReview(chain(failWith('INVALID_CREDENTIAL'), keys));

    expect(keys).not.toHaveBeenCalled();
    expect(run?.status).toBe('failed');
  });

  it('keeps the subscription price record when a configured fallback answered on its own subscription', async () => {
    const otherSubscription: ReviewModel = { label: 'openai:gpt-5', authMethod: 'subscription', includedInSubscription: true, generate: answer() };
    const model: ReviewModel = { ...chain(failWith('INVALID_CREDENTIAL'), answer()), fallbacks: [...chain(answer(), answer()).fallbacks!, otherSubscription] };
    const { run } = await dualReview(model);

    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toEqual({ source: 'subscription', inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('keeps an all-subscription run at $0 with its API-equivalent', async () => {
    const keys = answer();
    const { run } = await dualReview(chain(answer(), keys));

    expect(keys).not.toHaveBeenCalled();
    expect(run?.costUsd).toBe(0);
    expect(run?.result?.pricing).toMatchObject({ source: 'subscription', apiEquivalentSource: 'catalog:models.dev' });
    expect(run?.result?.fallbackFromMethod).toBeUndefined();
  });
});

describe('processReviewJob — a failed run keeps its spend and methods (ADR-0027 amendment)', () => {
  const brokenAnswer = () =>
    vi.fn(async () => ({ text: 'Here is my review, no JSON.', finishReason: 'stop' as const, usage }));

  it('records what the paid calls cost before the failure, counts it in the month and shows the switch', async () => {
    const keys = brokenAnswer();
    const { run, store } = await dualReview(chain(failWith('RATE_LIMIT'), keys));

    expect(run?.status).toBe('failed');
    const paid = keys.mock.calls.length * ((50 * 3 + 20 * 15) / 1_000_000);
    expect(paid).toBeGreaterThan(0);
    expect(run?.costUsd).toBeCloseTo(paid, 12);
    expect(await store.monthCostUsd(WORKSPACE_ID, new Date(Date.UTC(2000, 0, 1)))).toBeCloseTo(paid, 12);
    expect(run?.result).toMatchObject({
      summary: '',
      findings: [],
      fallbackFromMethod: 'subscription',
      modelUsedMethod: 'api-key',
      usage: { inputTokens: 50 * keys.mock.calls.length, outputTokens: 20 * keys.mock.calls.length },
      pricing: { source: 'catalog:models.dev' },
    });
    // Only counts and methods are stored: neither the provider's error nor the model's answer.
    expect(JSON.stringify(run?.result)).not.toMatch(/RATE_LIMIT from anthropic|no JSON/);
  });

  it('records $0 for a failed run that stayed on the subscription', async () => {
    const keys = answer();
    const { run } = await dualReview(chain(brokenAnswer(), keys));

    expect(keys).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: 'failed', costUsd: 0 });
    expect(run?.result?.pricing).toMatchObject({ source: 'subscription' });
    expect(run?.result?.fallbackFromMethod).toBeUndefined();
  });
});

describe('processReviewJob — budget admission of a subscription bot (ADR-0027)', () => {
  it('reserves the per-review budget when API keys stand behind the subscription', async () => {
    const { admit } = await dualReview(chain(answer(), answer()), { monthlyBudgetUsd: 10 });
    expect(admit.mock.calls[0]?.[1]).toBe(0.5);
  });

  it('reserves nothing for a subscription with no API keys', async () => {
    const { admit } = await dualReview(chain(answer(), answer()), { monthlyBudgetUsd: 10, state: subscriptionOnly });
    expect(admit.mock.calls[0]?.[1]).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import type { PriceEntry } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewRun, ReviewRunResultPayload, RunPricing } from '../core/types.js';
import { apiEquivalentUsage, registerApiEquivalentUsageRoute } from './api-equivalent-usage.js';
import type { Auth } from '../auth/auth.js';
import { requireRole } from '../auth/guard.js';

vi.mock('../auth/guard.js', () => ({
  requireRole: vi.fn(() => async (request: { headers: Record<string, unknown> }, reply: { status: (code: number) => { send: (body: unknown) => void } }) => {
    if (request.headers['x-member'] !== 'yes') reply.status(403).send({ error: 'Forbidden' });
  }),
}));

const MONTH = new Date('2026-10-01T00:00:00.000Z');
let sequence = 0;

/** The stored pricing record of a run, with the method switch the worker discloses beside it (ADR-0027). */
type StoredPricing = RunPricing & { fallbackFromMethod?: 'subscription' | 'api-key' | undefined };

function seed(
  store: MemoryStore,
  provider: string,
  model: string,
  pricing: StoredPricing,
  usage: { inputTokens: number; outputTokens: number },
  createdAt = '2026-10-15T00:00:00.000Z',
  judge?: ReviewRunResultPayload['judge'],
): void {
  sequence++;
  const now = new Date(createdAt);
  const { fallbackFromMethod, ...runPricing } = pricing;
  // The worker stores the method switch next to `pricing`, not inside it.
  const result: ReviewRunResultPayload = {
    v: 1, summary: '', highlights: [], findings: [], language: 'en', usage, pricing: runPricing,
    ...(fallbackFromMethod ? { fallbackFromMethod, modelUsedMethod: 'api-key' as const } : {}),
    ...(judge ? { judge } : {}),
  };
  const run: ReviewRun = {
    id: `run-${sequence}`, workspaceId: 'ws-1', installationId: 1, repoFullName: 'acme/repo',
    pullNumber: sequence, headSha: `sha-${sequence}`, status: 'completed', costUsd: 0, detail: null,
    createdAt: now, finishedAt: now, updatedAt: now, provider, model, result,
  };
  store.runs.set(run.id, run);
}

function setup(): MemoryStore {
  const store = new MemoryStore();
  store.settings.set('ws-1', {
    workspaceId: 'ws-1', provider: 'openai', model: 'gpt-x', language: 'en', monthlyBudgetUsd: null,
  });
  return store;
}

async function prices(store: MemoryStore, entries: PriceEntry[]): Promise<void> {
  await store.replaceModelPrices('models.dev', entries, new Date());
}

async function price(store: MemoryStore, provider: string, model: string, input = 2, output = 4): Promise<void> {
  await prices(store, [{ provider, model, inputPerMTok: input, outputPerMTok: output, source: 'models.dev' }]);
}

/** A manual workspace price for a model: it wins over every other source (ADR-0016). */
function overridePrice(store: MemoryStore, provider: string, model: string, input: number, output: number): void {
  const settings = store.settings.get('ws-1');
  if (!settings) throw new Error('the workspace has no settings');
  store.settings.set('ws-1', {
    ...settings,
    priceOverrides: [...(settings.priceOverrides ?? []), { provider, model, inputPerMTok: input, outputPerMTok: output }],
  });
}

/** The store with its price lookups counted, so the test can see how many the card makes. */
function spyStore(store: MemoryStore) {
  const getModelPrice = vi.fn((provider: string, model: string) => store.getModelPrice(provider, model));
  return {
    getModelPrice,
    store: {
      listApiEquivalentRuns: (workspaceId: string, providers: readonly string[]) => store.listApiEquivalentRuns(workspaceId, providers),
      getSettings: (workspaceId: string) => store.getSettings(workspaceId),
      getModelPrice,
    },
  };
}

const subscription: RunPricing = { source: 'subscription', inputPerMTok: 0, outputPerMTok: 0 };

describe('API-equivalent usage', () => {
  beforeEach(() => { sequence = 0; });

  it('uses a stored subscription part and its model split as recorded', async () => {
    const store = setup();
    seed(store, 'openai', 'gpt-x', {
      source: 'catalog:models.dev', inputPerMTok: 2, outputPerMTok: 4, fallbackFromMethod: 'subscription',
      subscriptionPart: {
        usd: 1.25, source: 'catalog:models.dev',
        byModel: [{ provider: 'openai', model: 'gpt-x', inputTokens: 10, outputTokens: 5, usd: 1.25 }],
      },
    }, { inputTokens: 999, outputTokens: 999 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ totalUsd: 1.25, monthUsd: 1.25, reviews: 1, averagePerReviewUsd: 1.25 });
    expect(result.byModel[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, usd: 1.25 });
  });

  it('prices an older subscription run from its tokens minus judge tokens', async () => {
    const store = setup();
    await price(store, 'openai', 'gpt-x');
    seed(store, 'openai', 'gpt-x', subscription, { inputTokens: 1_000_000, outputTokens: 500_000 }, undefined, {
      threshold: 0.3, checked: 1, filtered: [], duplicatesDropped: 0, attempts: [], inputTokens: 400_000, outputTokens: 100_000,
    });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result.totalUsd).toBeCloseTo(600_000 * 2 / 1_000_000 + 400_000 * 4 / 1_000_000);
    expect(result.byModel[0]).toMatchObject({ inputTokens: 600_000, outputTokens: 400_000 });
  });

  it('shows the tokens without the judge when a stored equivalent has no breakdown', async () => {
    const store = setup();
    seed(store, 'openai', 'gpt-x', { ...subscription, apiEquivalentUsd: 1.25 }, { inputTokens: 1_000_000, outputTokens: 500_000 }, undefined, {
      threshold: 0.3, checked: 1, filtered: [], duplicatesDropped: 0, attempts: [], inputTokens: 400_000, outputTokens: 100_000,
    });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result.totalUsd).toBe(1.25);
    expect(result.byModel[0]).toMatchObject({ provider: 'openai', model: 'gpt-x', inputTokens: 600_000, outputTokens: 400_000, usd: 1.25 });
  });

  it('prices a token-plan run at its mapped API provider', async () => {
    const store = setup();
    await prices(store, [
      { provider: 'zai', model: 'glm-x', inputPerMTok: 2, outputPerMTok: 4, source: 'models.dev' },
      { provider: 'zai-coding', model: 'glm-x', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
    ]);
    seed(store, 'zai-coding', 'glm-x', { source: 'catalog:models.dev', inputPerMTok: 0, outputPerMTok: 0 }, { inputTokens: 500_000, outputTokens: 100_000 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result.totalUsd).toBeCloseTo(1.4);
    expect(result.byModel[0]).toMatchObject({ provider: 'zai', model: 'glm-x' });
  });

  it('does not count a token-plan run a workspace price charges for real', async () => {
    const store = setup();
    await prices(store, [
      { provider: 'zai', model: 'glm-x', inputPerMTok: 2, outputPerMTok: 4, source: 'models.dev' },
      { provider: 'zai-coding', model: 'glm-x', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
    ]);
    overridePrice(store, 'zai-coding', 'glm-x', 2, 4);
    seed(store, 'zai-coding', 'glm-x', { source: 'override', inputPerMTok: 2, outputPerMTok: 4 }, { inputTokens: 500_000, outputTokens: 100_000 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ totalUsd: 0, reviews: 0, leftOut: 0 });
    expect(result.byModel).toEqual([]);
  });

  it('does not count a token-plan run the catalog does not price at $0', async () => {
    const store = setup();
    await prices(store, [
      { provider: 'zai', model: 'glm-x', inputPerMTok: 2, outputPerMTok: 4, source: 'models.dev' },
      { provider: 'zai-coding', model: 'glm-x', inputPerMTok: 1, outputPerMTok: 2, source: 'models.dev' },
    ]);
    // The workspace gives the plan away free, but the catalog prices it above $0: only a plan the
    // catalog itself prices at $0 has an equivalent (ADR-0024).
    overridePrice(store, 'zai-coding', 'glm-x', 0, 0);
    seed(store, 'zai-coding', 'glm-x', { source: 'override', inputPerMTok: 0, outputPerMTok: 0 }, { inputTokens: 500_000, outputTokens: 100_000 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ totalUsd: 0, reviews: 0, leftOut: 0 });
    expect(result.byModel).toEqual([]);
  });

  it('neither counts nor leaves out a run priced for real', async () => {
    const store = setup();
    await price(store, 'openai', 'gpt-x');
    seed(store, 'openai', 'gpt-x', { source: 'catalog:models.dev', inputPerMTok: 2, outputPerMTok: 4 }, { inputTokens: 100, outputTokens: 50 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ totalUsd: 0, reviews: 0, averagePerReviewUsd: 0, leftOut: 0 });
    expect(result.byModel).toEqual([]);
  });

  it('counts an unpriceable subscription run as left out', async () => {
    const store = setup();
    seed(store, 'anthropic', 'unknown', subscription, { inputTokens: 100, outputTokens: 50 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ leftOut: 1, reviews: 0, totalUsd: 0 });
  });

  it('leaves out an older mixed run that fell back from the subscription', async () => {
    const store = setup();
    seed(store, 'openai', 'gpt-x', {
      source: 'catalog:models.dev', inputPerMTok: 2, outputPerMTok: 4, fallbackFromMethod: 'subscription',
    }, { inputTokens: 100, outputTokens: 50 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ leftOut: 1, reviews: 0, totalUsd: 0 });
    expect(result.byModel).toEqual([]);
  });

  it('leaves out a run whose subscription part had no API price', async () => {
    const store = setup();
    seed(store, 'openai', 'gpt-x', { ...subscription, subscriptionPart: null }, { inputTokens: 100, outputTokens: 50 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ leftOut: 1, reviews: 0, totalUsd: 0 });
  });

  it('leaves out an older mixed run even when its own model has a price', async () => {
    const store = setup();
    await price(store, 'openai', 'gpt-x');
    seed(store, 'openai', 'gpt-x', { ...subscription, fallbackFromMethod: 'subscription' }, { inputTokens: 100, outputTokens: 50 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ leftOut: 1, reviews: 0, totalUsd: 0 });
  });

  it('leaves out an older run that switched from API keys to the subscription', async () => {
    const store = setup();
    await price(store, 'openai', 'gpt-x');
    seed(store, 'openai', 'gpt-x', { source: 'catalog:models.dev', inputPerMTok: 2, outputPerMTok: 4, fallbackFromMethod: 'api-key' }, { inputTokens: 100, outputTokens: 50 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ leftOut: 1, reviews: 0 });
  });

  it('neither counts nor leaves out a switch whose subscription answered nothing', async () => {
    const store = setup();
    seed(store, 'openai', 'gpt-x', {
      source: 'catalog:models.dev', inputPerMTok: 2, outputPerMTok: 4, fallbackFromMethod: 'subscription',
      subscriptionPart: { usd: 0, byModel: [], source: 'subscription' },
    }, { inputTokens: 100, outputTokens: 50 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ leftOut: 0, reviews: 0, totalUsd: 0 });
  });

  it('neither counts nor leaves out a subscription run that failed before any call', async () => {
    const store = setup();
    const now = new Date('2026-10-15T00:00:00.000Z');
    store.runs.set('run-failed', {
      id: 'run-failed', workspaceId: 'ws-1', installationId: 1, repoFullName: 'acme/repo', pullNumber: 99,
      headSha: 'sha-failed', status: 'failed', costUsd: 0, detail: null, createdAt: now, finishedAt: now, updatedAt: now,
      provider: 'openai', model: 'gpt-x',
      result: { v: 1, summary: '', highlights: [], findings: [], language: 'en', pricing: subscription },
    });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ leftOut: 0, reviews: 0 });
  });

  it('prices a subscription run recorded as static at $0 before ADR-0024', async () => {
    const store = setup();
    await price(store, 'anthropic', 'claude-x');
    seed(store, 'anthropic', 'claude-x', { source: 'static', inputPerMTok: 0, outputPerMTok: 0 }, { inputTokens: 1_000_000, outputTokens: 0 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ reviews: 1, leftOut: 0 });
    expect(result.totalUsd).toBeCloseTo(2);
  });

  it('shows a stored token-plan equivalent under its API provider, as a run priced now shows it', async () => {
    const store = setup();
    seed(store, 'zai-coding', 'glm-x', { source: 'catalog:models.dev', inputPerMTok: 0, outputPerMTok: 0, apiEquivalentUsd: 0.5 }, { inputTokens: 10, outputTokens: 5 });
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result.byModel).toEqual([{ provider: 'zai', model: 'glm-x', inputTokens: 10, outputTokens: 5, usd: 0.5 }]);
  });

  it('separates the current month from all retained runs', async () => {
    const store = setup();
    seed(store, 'openai', 'gpt-x', { ...subscription, apiEquivalentUsd: 2 }, { inputTokens: 1, outputTokens: 1 });
    seed(store, 'openai', 'gpt-x', { ...subscription, apiEquivalentUsd: 3 }, { inputTokens: 1, outputTokens: 1 }, '2026-09-30T23:59:59.000Z');
    const result = await apiEquivalentUsage({ store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(result).toMatchObject({ monthUsd: 2, totalUsd: 5, reviews: 2, averagePerReviewUsd: 2.5, monthStart: MONTH.toISOString() });
  });

  it('looks the price of a model up once for many runs of it', async () => {
    const store = setup();
    await price(store, 'openai', 'gpt-x');
    const spied = spyStore(store);
    for (let i = 0; i < 50; i++) seed(store, 'openai', 'gpt-x', subscription, { inputTokens: 1_000, outputTokens: 500 });
    const result = await apiEquivalentUsage({ store: spied.store, auth: {} as Auth }, 'ws-1', MONTH);
    expect(spied.getModelPrice).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reviews: 50, leftOut: 0 });
    expect(result.totalUsd).toBeCloseTo(0.2);
  });

  it('requires workspace membership on the route', async () => {
    const store = setup();
    const app = fastify();
    registerApiEquivalentUsageRoute(app, { store, auth: {} as Auth, now: () => new Date('2026-10-20T00:00:00.000Z') });
    expect(requireRole).toHaveBeenCalledWith('member', expect.anything());
    const denied = await app.inject({ method: 'GET', url: '/api/workspaces/ws-1/usage/api-equivalent' });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: 'GET', url: '/api/workspaces/ws-1/usage/api-equivalent', headers: { 'x-member': 'yes' } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().monthStart).toBe(MONTH.toISOString());
    await app.close();
  });
});

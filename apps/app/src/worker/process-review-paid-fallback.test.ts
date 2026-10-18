import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReviewModel, encodeSubscription, LlmFailure, Secret, type ReviewModel } from '@mergepilot/engine';
import { BudgetAdmission } from './budget-admission.js';
import { panelSetup, WS } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

vi.mock('@mergepilot/engine', async (original) => {
  const actual = await original<typeof import('@mergepilot/engine')>();
  return { ...actual, createReviewModel: vi.fn(actual.createReviewModel) };
});

const factory = vi.mocked(createReviewModel);
const reason = 'skipped: the review was admitted free under the monthly budget';
const fallback = [{ provider: 'openai' as const, model: 'gpt-5', effort: null }];
const response = { text: JSON.stringify({ summary: 'LGTM', findings: [] }), finishReason: 'stop' as const,
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } };

afterEach(() => vi.clearAllMocks());

async function setup(budget: number | null, extra = false, fail = false, sameProvider = false, paidPrimary = false, custom = false,
  options: { monthlyCost?: number; perReviewUsd?: number; normalPaid?: boolean } = {},
) {
  const configured = sameProvider ? [{ provider: 'anthropic' as const, model: 'other', effort: null }]
    : custom ? [...fallback, { provider: 'custom' as const, model: 'custom-model', effort: null }] : fallback;
  const h = await panelSetup({
    settings: { monthlyBudgetUsd: budget, fallback: options.normalPaid || (extra && !paidPrimary) ? [] : configured,
      ...(options.normalPaid ? { provider: 'openai' as const } : {}) },
    ...(options.monthlyCost !== undefined ? { monthlyCost: options.monthlyCost } : {}),
    ...(options.perReviewUsd !== undefined ? { repoFiles: { '.mergepilot.yml': `budget:\n  perReviewUsd: ${options.perReviewUsd}\n` } } : {}),
    bots: extra ? [{ slot: 2, provider: paidPrimary ? 'openai' : 'anthropic', fallback: configured }] : [],
  });
  const credentials = {
    resolve: vi.fn(async (_ws: string, provider: string) => provider === 'anthropic'
      ? new Secret(encodeSubscription('anthropic', { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 }))
      : new Secret('test-key')),
    getDualAuthState: vi.fn(async (_ws: string, provider: string) => ({ hasSubscription: provider === 'anthropic', hasApiKeys: provider !== 'anthropic', preference: null, effective: provider === 'anthropic' ? 'subscription' as const : 'api-key' as const })),
    getEffectiveAuthMethod: vi.fn(async (_ws: string, provider: string) => provider === 'anthropic' ? 'subscription' as const : 'api-key' as const),
    resolveKeyRoster: vi.fn(async () => ({ secrets: [new Secret('test-key')], keyIds: ['key'], startIndex: 0 })),
  };
  const actual = await vi.importActual<typeof import('@mergepilot/engine')>('@mergepilot/engine');
  const called: string[] = [];
  factory.mockImplementation(async (...args) => {
    const model = await actual.createReviewModel(...args);
    const wire = (entry: ReviewModel, primary: boolean) => {
      entry.generate = vi.fn(async () => {
        called.push(entry.label);
        if (primary && fail) throw new LlmFailure({ code: 'INVALID_CREDENTIAL', provider: 'anthropic', message: 'subscription rejected' });
        return response;
      });
    };
    wire(model, true);
    for (const entry of model.fallbacks ?? []) wire(entry, false);
    return model;
  });
  const admission = new BudgetAdmission();
  const admit = vi.spyOn(admission, 'admit');
  const credentialRead = vi.spyOn(h.store, 'getCredential');
  const { createModelForProvider: _seam, ...deps } = h.deps;
  const result = await processReviewJob(h.job, { ...deps, credentials, budgetAdmission: admission });
  return { ...h, credentials, credentialRead, admit, result, called, held: admission.heldUsd(WS) };
}

describe('free bots with paid configured fallbacks (ADR-0035)', () => {
  it('keeps ordinary paid admission unchanged at $9.50 of $10 with a $1 reservation', async () => {
    const h = await setup(10, false, false, false, false, false,
      { monthlyCost: 9.5, perReviewUsd: 1, normalPaid: true });
    expect(h.admit.mock.calls.map((call) => call[1])).toEqual([1]);
    expect(h.result.status).toBe('completed');
    expect(h.called).toContain('openai:main-model');
  });

  it('admits free and discloses the skipped paid fallback at $9.50 of $10 with a $1 reservation', async () => {
    const h = await setup(10, false, false, false, false, false, { monthlyCost: 9.5, perReviewUsd: 1 });
    expect(h.admit.mock.calls.map((call) => call[1])).toEqual([1, 0]);
    expect(h.result.status).toBe('completed');
    expect(h.called).not.toContain('openai:gpt-5');
    expect((await h.runs())[0]?.detail).toContain(reason);
    expect((await factory.mock.results[0]!.value).skippedFallbacks).toEqual([{ label: 'openai:gpt-5', reason }]);
  });

  it('uses the original predicate for the paid base on pass two even when its reservation exceeds the remainder', async () => {
    const h = await setup(10, true, false, false, true, false, { monthlyCost: 9.5, perReviewUsd: 1 });
    expect(h.admit.mock.calls.map((call) => call[1])).toEqual([2, 1]);
    expect((await h.runs()).every((run) => run.status === 'completed')).toBe(true);
    expect((await h.runs())[0]?.detail).toContain(reason);
  });

  it.each([false, true])('reserves for the paid fallback before running (extra=%s)', async (extra) => {
    const h = await setup(10, extra, true);
    expect(h.admit.mock.calls.map((call) => call[1])).toEqual([0.5]);
    expect(h.called).toContain('openai:gpt-5');
    const runs = await h.runs();
    const run = runs.find((entry) => entry.botSlot === (extra ? 2 : 1));
    expect(run).toMatchObject({ status: 'completed', costUsd: null, fallbackFrom: expect.any(String) });
    expect(run?.result?.usage?.inputTokens).toBeGreaterThan(0);
    expect(h.held).toBe(0);
  });

  it.each([false, true])('retries free, skips paid providers and surfaces the subscription error (extra=%s)', async (extra) => {
    const h = await setup(0.1, extra, true);
    expect(h.admit.mock.calls.map((call) => call[1])).toEqual([0.5, 0]);
    expect(h.called).not.toContain('openai:gpt-5');
    expect(h.credentials.resolveKeyRoster).not.toHaveBeenCalled();
    const model = await factory.mock.results[extra ? 1 : 0]!.value;
    expect(model.skippedFallbacks).toEqual([{ label: 'openai:gpt-5', reason }]);
    expect((await h.runs()).find((run) => run.botSlot === (extra ? 2 : 1))).toMatchObject({ status: 'failed', detail: expect.stringContaining('subscription rejected') });
    expect((await h.runs()).find((run) => run.botSlot === (extra ? 2 : 1))?.detail).toContain(reason);
    expect(h.held).toBe(0);
  });

  it('keeps the existing whole-review skip when the monthly budget is already reached', async () => {
    const h = await setup(0.1, true, false, false, true, false, { monthlyCost: 0.1 });
    expect(h.result).toMatchObject({ status: 'skipped', detail: 'monthly budget reached' });
    expect(h.admit.mock.calls.map((call) => call[1])).toEqual([1, 0.5]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('keeps a fallback on its own provider free and available', async () => {
    const h = await setup(0.1, false, true, true);
    expect(h.admit.mock.calls.map((call) => call[1])).toEqual([0]);
    expect(h.called).toContain('anthropic:other');
    expect(h.credentials.resolveKeyRoster).not.toHaveBeenCalled();
  });

  it('does not admit or exclude paid fallbacks without a monthly budget', async () => {
    const h = await setup(null, false, true);
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.called).toContain('openai:gpt-5');
  });

  it('excludes custom URL and key roster loading and snapshots each provider once', async () => {
    const h = await setup(0.1, true, false, false, false, true);
    expect(h.credentialRead.mock.calls.some((call) => call[1] === 'custom')).toBe(false);
    expect(h.credentials.resolveKeyRoster).not.toHaveBeenCalled();
    expect(h.credentials.resolve.mock.calls.some((call) => call[1] === 'custom')).toBe(false);
    const models = await Promise.all(factory.mock.results.map((call) => call.value));
    expect(models[1]?.skippedFallbacks).toEqual([
      { label: 'openai:gpt-5', reason }, { label: 'custom:custom-model', reason },
    ]);
    expect((await h.runs())[1]?.detail).toContain(reason);
    // The model builder reads live dual state too; admission's two passes share one read.
    expect(h.credentials.getDualAuthState.mock.calls.filter((call) => call[1] === 'openai')).toHaveLength(1);
  });
});

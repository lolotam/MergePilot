import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { refreshSubscription, SubscriptionRefreshError, SUBSCRIPTION_REFRESH_MARGIN_MS, type ReviewModel, type SubscriptionProvider } from '@mergepilot/engine';
import { CredentialService } from '../credentials/service.js';
import type { JudgeSettings } from '../core/types.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { BudgetAdmission } from './budget-admission.js';
import { createHarness, keyFor, WORKSPACE_ID } from './model-settings.fixtures.js';
import { processReviewJob } from './process-review.js';

const calls = vi.hoisted(() => ({
  quota: false,
  summary: 'Fallback review',
  requests: [] as Array<{ label: string; method: string | undefined; request: unknown }>,
}));

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return {
    ...actual,
    refreshSubscription: vi.fn(),
    createReviewModel: vi.fn(async (...args: Parameters<typeof actual.createReviewModel>) => {
      const model = await actual.createReviewModel(...args);
      const failedPrimary = args[2].primarySubscriptionFailure ? model : undefined;
      const stub = (entry: ReviewModel): ReviewModel => ({
        ...entry,
        ...(entry.fallbacks ? { fallbacks: entry.fallbacks.map(stub) } : {}),
        ...((entry !== failedPrimary && (entry.label.startsWith('openai:') || entry.label.startsWith('gemini:') || entry.authMethod === 'api-key' || calls.quota)) ? {
          generate: vi.fn(async (request) => {
            calls.requests.push({ label: entry.label, method: entry.authMethod, request });
            if (entry.label.startsWith('anthropic:')) {
              throw new actual.LlmFailure({ provider: 'anthropic', code: 'QUOTA', message: 'Subscription quota exhausted' });
            }
            return {
              text: JSON.stringify({ summary: calls.summary, findings: [] }),
              finishReason: 'stop' as const,
              usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
            };
          }),
        } : {}),
      });
      return stub(model);
    }),
  };
});

const PRIMARY = 'anthropic:claude-3-5-sonnet';
const FALLBACK = { provider: 'openai' as const, model: 'gpt-5' };
const access = keyFor('failed-subscription-access');
const refresh = keyFor('failed-subscription-refresh');

beforeEach(() => {
  vi.clearAllMocks();
  calls.quota = false;
  calls.summary = 'Fallback review';
  calls.requests.length = 0;
  vi.mocked(refreshSubscription).mockRejectedValue(new SubscriptionRefreshError('sign-in'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function review(options: {
  fallback?: boolean;
  freeFallback?: boolean;
  monthlyBudgetUsd?: number;
  dual?: boolean;
  extra?: boolean;
  provider?: SubscriptionProvider;
  unavailable?: 'missing' | 'undecodable' | 'undecryptable';
  quota?: boolean;
  judgePlacement?: 'primary' | 'fallback';
  constructionRefresh?: 2 | 3;
} = {}) {
  const provider = options.provider ?? 'anthropic';
  const model = { anthropic: 'claude-3-5-sonnet', openai: 'gpt-primary', xai: 'grok-4', 'google-antigravity': 'claude-sonnet-4-5' }[provider];
  const fallback = provider === 'openai' ? { provider: 'gemini' as const, model: 'gemini-2.5-pro' } : FALLBACK;
  const configured = options.fallback === false ? [] : [fallback];
  const h = createHarness({ settings: {
    provider: options.extra ? 'openai' : provider,
    model: options.extra ? 'gpt-main' : model,
    fallback: options.extra ? [] : configured,
    monthlyBudgetUsd: options.monthlyBudgetUsd ?? null,
  } });
  const vault = new EnvelopeVault(Buffer.alloc(32, 29).toString('base64'));
  const credentials = new CredentialService({ store: h.store, vault });
  const expires = Date.now() + SUBSCRIPTION_REFRESH_MARGIN_MS + 120_000;
  await credentials.saveSubscription(WORKSPACE_ID, provider, {
    type: 'oauth', access, refresh, expires: options.constructionRefresh ? expires : options.quota ? Date.now() + 3_600_000 : 0,
  }, 'owner');
  if (options.freeFallback) {
    await credentials.saveSubscription(WORKSPACE_ID, 'openai', {
      type: 'oauth', access: keyFor('fallback-access'), refresh: keyFor('fallback-refresh'), expires: Date.now() + 3_600_000,
    }, 'owner');
  } else {
    await credentials.saveKey({ workspaceId: WORKSPACE_ID, provider: fallback.provider, apiKey: keyFor('fallback-api'), userId: 'owner' });
  }
  if (options.dual) {
    await credentials.saveKey({ workspaceId: WORKSPACE_ID, provider: 'anthropic', apiKey: keyFor('primary-api'), userId: 'owner' });
  }
  if (options.unavailable === 'missing') await credentials.deleteKey(WORKSPACE_ID, provider);
  if (options.unavailable === 'undecodable' || options.unavailable === 'undecryptable') {
    const stored = (await h.store.getCredential(WORKSPACE_ID, provider))!;
    const ciphertext = options.unavailable === 'undecryptable'
      ? 'invalid-ciphertext'
      : await vault.encrypt('mergepilot:oauth:v1:invalid', { workspaceId: WORKSPACE_ID, provider });
    await h.store.saveCredential({ ...stored, ciphertext });
  }
  if (options.extra) {
    await h.store.upsertReviewerBot(WORKSPACE_ID, {
      slot: 2, name: 'Extra', logo: 'owl', active: true, provider, model, effort: null, fallback: configured,
    });
  }
  if (options.judgePlacement) {
    const settings = (await h.store.getSettings(WORKSPACE_ID))!;
    // Subscription providers are not currently offered for judges; exercise setup with a stored entry.
    const judge = {
      enabled: true, provider: options.judgePlacement === 'primary' ? provider : 'typesafe', model: 'jev-latest',
      uses: [], threshold: 0.5,
      fallback: options.judgePlacement === 'fallback' ? [{ provider, model: 'jev-latest' }] : [],
    } as unknown as JudgeSettings;
    await h.store.saveSettings({ ...settings, judge });
  }
  let primaryResolves = 0;
  if (options.constructionRefresh) {
    const resolve = credentials.resolve.bind(credentials);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(credentials, 'resolve').mockImplementation(async (workspaceId, entryProvider) => {
      if (entryProvider === provider && ++primaryResolves === options.constructionRefresh) clock.mockReturnValue(expires + 1);
      return resolve(workspaceId, entryProvider);
    });
  }
  const lines: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const admission = new BudgetAdmission();
  const admit = vi.spyOn(admission, 'admit');
  const { createModelForProvider: _unused, ...deps } = h.deps;
  calls.quota = options.quota ?? false;
  h.client.getPullRequest = async () => ({ head: { sha: h.job.headSha }, title: `PR ${access}`, body: refresh });
  const result = await processReviewJob(h.job, { ...deps, credentials, logger, log: (line) => logs.push(line), budgetAdmission: admission });
  const runs = await h.store.listReviewRuns(WORKSPACE_ID);
  const run = runs.find((entry) => entry.botSlot === (options.extra ? 2 : 1));
  return { ...h, result, run, runs, lines, logs, admit, primaryResolves, primaryLabel: `${provider}:${model}`, fallback };
}

function warning(h: Awaited<ReturnType<typeof review>>, reason: string) {
  const events = h.lines.filter((line) => line.event === 'credential.primary_unavailable');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ workspaceId: WORKSPACE_ID, runId: h.run?.id, provider: h.run?.fallbackFrom?.split(':')[0] ?? h.run?.provider, reason });
}

describe('processReviewJob — an unavailable subscription enters the configured fallback chain', () => {
  it.each(['primary', 'fallback'] as const)('does not repeat a refused primary refresh for the judge %s', async (judgePlacement) => {
    const h = await review({ judgePlacement });
    expect(h.run).toMatchObject({ status: 'completed', provider: 'openai', fallbackFrom: PRIMARY });
    expect(h.reviews[0]?.body).toContain('auth');
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it.each([
    { dual: false, constructionRefresh: 2 as const },
    { dual: true, constructionRefresh: 2 as const },
    { dual: true, constructionRefresh: 3 as const },
  ])('falls back after refresh is refused on construction resolve $constructionRefresh with dual methods $dual', async (options) => {
    const failure = new SubscriptionRefreshError('sign-in');
    failure.message += ` ${access} ${refresh}`;
    vi.mocked(refreshSubscription).mockRejectedValue(failure);
    const h = await review(options);
    expect(h.run).toMatchObject({ status: 'completed', provider: 'openai', model: 'gpt-5', fallbackFrom: PRIMARY, costUsd: null });
    expect(h.reviews[0]?.body).toContain(PRIMARY);
    expect(h.reviews[0]?.body).toContain('auth');
    expect(h.reviews[0]?.body).toContain('Subscription token refresh failed; sign in again');
    expect(calls.requests.map((entry) => entry.label)).toEqual(['openai:gpt-5']);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    expect(h.primaryResolves).toBe(options.constructionRefresh);
    warning(h, 'sign-in');
    const visible = JSON.stringify({ runs: h.runs, reviews: h.reviews, lines: h.lines, logs: h.logs, requests: calls.requests });
    expect(visible).not.toContain(access);
    expect(visible).not.toContain(refresh);
  });

  it.each([
    { dual: false, constructionRefresh: 2 as const },
    { dual: true, constructionRefresh: 3 as const },
  ])('keeps construction-time unreachable refresh transient with dual methods $dual', async (options) => {
    vi.mocked(refreshSubscription).mockRejectedValue(new SubscriptionRefreshError('unreachable'));
    const h = await review(options);
    expect(h.run).toMatchObject({ status: 'failed', detail: 'Subscription token refresh could not reach the provider; try again', fallbackFrom: null });
    expect(calls.requests).toHaveLength(0);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    expect(h.primaryResolves).toBe(options.constructionRefresh);
    expect(h.lines.filter((line) => line.event === 'credential.primary_unavailable')).toHaveLength(0);
  });

  it.each(['anthropic', 'openai', 'xai', 'google-antigravity'] as const)('continues from %s after refused refresh and discloses ordinary auth fallback', async (provider) => {
    const h = await review({ provider });
    expect(h.run).toMatchObject({ status: 'completed', provider: h.fallback.provider, model: h.fallback.model, fallbackFrom: h.primaryLabel, costUsd: null });
    expect(h.reviews[0]?.body).toContain(h.primaryLabel);
    expect(h.reviews[0]?.body).toContain('auth');
    expect(h.reviews[0]?.body).toContain('sign in again');
    expect(h.run?.result?.pricing?.apiEquivalentUsd).toBeUndefined();
    expect(calls.requests.map((entry) => entry.label)).toEqual([`${h.fallback.provider}:${h.fallback.model}`]);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it('keeps the sign-in detail when no configured fallback is allowed', async () => {
    const h = await review({ fallback: false });
    expect(h.run).toMatchObject({ status: 'failed', detail: 'Subscription token refresh failed; sign in again', fallbackFrom: null });
    expect(calls.requests).toHaveLength(0);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it('uses a configured fallback when Google sign-in is not configured on the server', async () => {
    vi.mocked(refreshSubscription).mockRejectedValue(new SubscriptionRefreshError('not-configured'));
    const h = await review({ provider: 'google-antigravity' });
    expect(h.run).toMatchObject({ status: 'completed', provider: 'openai', fallbackFrom: 'google-antigravity:claude-sonnet-4-5' });
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'not-configured');
  });

  it.each(['missing', 'undecodable', 'undecryptable'] as const)('falls back when the primary stored credential is %s', async (unavailable) => {
    const h = await review({ unavailable });
    expect(h.run).toMatchObject({ status: 'completed', provider: 'openai', fallbackFrom: PRIMARY });
    expect(h.reviews[0]?.body).toContain('auth');
    expect(refreshSubscription).not.toHaveBeenCalled();
    expect(h.lines.filter((line) => line.event === 'credential.primary_unavailable')).toHaveLength(1);
  });

  it('also lets an extra reviewer bot use its configured fallback', async () => {
    const h = await review({ extra: true });
    expect(h.runs).toHaveLength(2);
    expect(h.runs.every((run) => run.status === 'completed')).toBe(true);
    expect(h.run).toMatchObject({ botSlot: 2, provider: 'openai', model: 'gpt-5', fallbackFrom: PRIMARY });
    expect(h.reviews.find((entry) => entry.body.includes('Extra'))?.body).toContain('auth');
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it.each(['anthropic', 'google-antigravity'] as const)('keeps %s subscription-only admission and zero cost for a free configured fallback', async (provider) => {
    const h = await review({ provider, freeFallback: true, monthlyBudgetUsd: 10 });
    expect(h.admit.mock.calls[0]?.[1]).toBe(0);
    expect(h.run).toMatchObject({ status: 'completed', fallbackFrom: h.primaryLabel, costUsd: 0 });
    // No API price for the fallback's model here: its subscription part is marked unpriced (ADR-0047).
    expect(h.run?.result?.pricing).toEqual({ source: 'subscription', inputPerMTok: 0, outputPerMTok: 0, subscriptionPart: null });
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it('does not enter a paid configured fallback after free admission', async () => {
    const h = await review({ monthlyBudgetUsd: 0.1 });
    expect(h.admit.mock.calls.map((args) => args[1])).toEqual([0.5, 0]);
    expect(h.run?.status).toBe('failed');
    expect(h.run?.detail).toContain('Subscription token refresh failed; sign in again');
    expect(h.run?.detail).toContain('admitted free');
    expect(calls.requests).toHaveLength(0);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it('skips the same-provider API method on auth failure and uses the configured model fallback', async () => {
    const h = await review({ dual: true });
    expect(h.run).toMatchObject({ status: 'completed', provider: 'openai', fallbackFrom: PRIMARY });
    expect(calls.requests.map((entry) => entry.label)).toEqual(['openai:gpt-5']);
    expect(h.run?.result?.fallbackFromMethod).toBeUndefined();
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it('redacts readable failed-primary tokens from prompts, disclosure, errors and stored results', async () => {
    const failure = new SubscriptionRefreshError('sign-in');
    failure.message += ` ${access} ${refresh}`;
    vi.mocked(refreshSubscription).mockRejectedValue(failure);
    const h = await review();
    expect(h.run?.status).toBe('completed');
    const visible = JSON.stringify({ runs: h.runs, reviews: h.reviews, lines: h.lines, logs: h.logs, requests: calls.requests });
    expect(visible).not.toContain(access);
    expect(visible).not.toContain(refresh);
    expect(h.reviews[0]?.body).toContain('sign in again');
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it.each([false, true])('keeps a token-free sign-in detail without fallback when dual methods are %s', async (dual) => {
    const failure = new SubscriptionRefreshError('sign-in');
    failure.message += ` ${access} ${refresh}`;
    vi.mocked(refreshSubscription).mockRejectedValue(failure);
    const h = await review({ fallback: false, dual });
    expect(h.run).toMatchObject({ status: 'failed', detail: 'Subscription token refresh failed; sign in again', fallbackFrom: null });
    expect(calls.requests).toHaveLength(0);
    const visible = JSON.stringify({ runs: h.runs, reviews: h.reviews, lines: h.lines, logs: h.logs });
    expect(visible).not.toContain(access);
    expect(visible).not.toContain(refresh);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    warning(h, 'sign-in');
  });

  it('keeps unreachable refresh failure transient without calling the configured fallback', async () => {
    vi.mocked(refreshSubscription).mockRejectedValue(new SubscriptionRefreshError('unreachable'));
    const h = await review();
    expect(h.run).toMatchObject({ status: 'failed', detail: 'Subscription token refresh could not reach the provider; try again', fallbackFrom: null });
    expect(calls.requests).toHaveLength(0);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    expect(h.lines.filter((line) => line.event === 'credential.primary_unavailable')).toHaveLength(0);
  });

  it('still uses the configured fallback after a primary subscription quota failure', async () => {
    const h = await review({ quota: true });
    expect(h.run).toMatchObject({ status: 'completed', provider: 'openai', fallbackFrom: PRIMARY });
    expect(h.reviews[0]?.body).toContain('quota');
    expect(calls.requests.map((entry) => entry.label)).toEqual([PRIMARY, 'openai:gpt-5']);
    expect(refreshSubscription).not.toHaveBeenCalled();
  });
});

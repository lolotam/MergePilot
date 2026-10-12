import { describe, expect, it, vi } from 'vitest';
import { LlmFailure, type ReviewModel } from '@mergepilot/engine';
import { processReviewJob } from './process-review.js';
import { createHarness, keyFor, reviewStream } from './model-settings.fixtures.js';

const okAnswer = async () => ({
  text: JSON.stringify({ summary: 'LGTM', findings: [] }),
  finishReason: 'stop' as const,
  usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

describe('worker: heavy-duty model, effort, fallback and minimum severity (J2)', () => {
  const heavySettings = {
    provider: 'anthropic' as const,
    model: 'claude-3-5-haiku',
    effort: 'low',
    heavyProvider: 'openai' as const,
    heavyModel: 'gpt-5-pro',
    heavyEffort: 'high',
    heavyThresholdLines: 500,
  };

  it('uses the heavy model and its effort when additions + deletions reach the threshold', async () => {
    const h = createHarness({ settings: heavySettings, additions: 300, deletions: 200 });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');
    expect(h.getCapturedConfig()).toMatchObject({ provider: 'openai', model: 'gpt-5-pro', effort: 'high' });
    expect(await h.latestRun()).toMatchObject({ provider: 'openai', model: 'gpt-5-pro', effort: 'high', fallbackFrom: null });
    expect(h.credentials.resolve).toHaveBeenCalledWith(expect.any(String), 'openai');
  });

  it('keeps the workspace model below the threshold', async () => {
    const h = createHarness({ settings: heavySettings, additions: 100, deletions: 50 });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');
    expect(h.getCapturedConfig()).toMatchObject({ provider: 'anthropic', model: 'claude-3-5-haiku', effort: 'low' });
    expect(await h.latestRun()).toMatchObject({ provider: 'anthropic', model: 'claude-3-5-haiku', effort: 'low' });
  });

  it('defaults the threshold to 800 changed lines and never carries the primary effort to the heavy model', async () => {
    const settings = { ...heavySettings, heavyThresholdLines: null, heavyEffort: null };
    const small = createHarness({ settings, additions: 500, deletions: 299 });
    await processReviewJob(small.job, small.deps);
    expect(small.getCapturedConfig()?.model).toBe('claude-3-5-haiku');

    const large = createHarness({ settings, additions: 500, deletions: 300 });
    await processReviewJob(large.job, large.deps);
    expect(large.getCapturedConfig()?.model).toBe('gpt-5-pro');
    expect(large.getCapturedConfig()?.effort).toBeUndefined();
  });

  it('counts changed lines from the PR files when the PR payload has no additions/deletions', async () => {
    const large = createHarness({ settings: heavySettings, omitCounts: true, fileLines: 900 });
    await processReviewJob(large.job, large.deps);
    expect(large.getCapturedConfig()?.model).toBe('gpt-5-pro');

    const small = createHarness({ settings: heavySettings, omitCounts: true, fileLines: 20 });
    await processReviewJob(small.job, small.deps);
    expect(small.getCapturedConfig()?.model).toBe('claude-3-5-haiku');
  });

  it('uses the PR payload counts without listing files first, and skips counting without a heavy model', async () => {
    const withCounts = createHarness({ settings: heavySettings, additions: 400, deletions: 100, fileLines: 1 });
    await processReviewJob(withCounts.job, withCounts.deps);
    expect(withCounts.getCapturedConfig()?.model).toBe('gpt-5-pro');
    const listedBeforeReview = withCounts.client.listPullRequestFilesPage.mock.calls.length;

    const noHeavy = createHarness({ settings: { provider: 'anthropic', model: 'm' }, omitCounts: true });
    await processReviewJob(noHeavy.job, noHeavy.deps);
    expect(noHeavy.client.listPullRequestFilesPage.mock.calls.length).toBe(listedBeforeReview);
  });

  it('passes the fallback chain and the minimum severity, with no baseUrl on any entry', async () => {
    const h = createHarness({
      settings: {
        fallback: [
          { provider: 'openai', model: 'gpt-4o', effort: 'medium' },
          { provider: 'custom', model: 'llama-3.3' },
        ],
        minSeverity: 'critical',
      },
      customBaseUrl: 'https://llm.example.com/v1',
    });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');
    const config = h.getCapturedConfig();
    expect(config?.review.minSeverity).toBe('critical');
    expect(config?.fallback).toEqual([
      { provider: 'openai', model: 'gpt-4o', effort: 'medium' },
      { provider: 'custom', model: 'llama-3.3' },
    ]);
    expect(config?.baseUrl).toBeUndefined();
  });

  it('never lists the chosen model as its own fallback, and drops repeated entries', async () => {
    const h = createHarness({
      settings: {
        ...heavySettings,
        fallback: [
          { provider: 'openai', model: 'gpt-5-pro', effort: 'high' },
          { provider: 'gemini', model: 'gemini-3.8-flash' },
          { provider: 'gemini', model: 'gemini-3.8-flash' },
        ],
      },
      additions: 900,
      deletions: 0,
    });
    await processReviewJob(h.job, h.deps);
    expect(h.getCapturedConfig()?.model).toBe('gpt-5-pro');
    expect(h.getCapturedConfig()?.fallback).toEqual([{ provider: 'gemini', model: 'gemini-3.8-flash' }]);
  });

  it('records the fallback that answered and discloses it in the published summary', async () => {
    const fallback: ReviewModel = { label: 'openai:gpt-4o', generate: vi.fn(okAnswer) };
    const primary: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async () => {
        throw new LlmFailure({ code: 'RATE_LIMIT', provider: 'anthropic', message: 'slow down' });
      }),
      fallbacks: [fallback],
    };
    const h = createHarness({
      settings: { fallback: [{ provider: 'openai', model: 'gpt-4o', effort: 'medium' }] },
      fakeModel: primary,
    });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');
    expect(await h.latestRun()).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      effort: 'medium',
      fallbackFrom: 'anthropic:claude-3-5-sonnet',
    });
    const body = h.reviews[0]?.body ?? '';
    expect(body).toContain('openai:gpt-4o');
    expect(body).toContain('anthropic:claude-3-5-sonnet');
  });
});

describe('worker: custom base URL comes only from the workspace key and is re-checked per call (ADR-0010)', () => {
  it('calls the stored custom URL through the guarded fetch with the stored key', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const customFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return reviewStream();
    });
    const h = createHarness({
      settings: { provider: 'custom', model: 'llama-3.3' },
      customBaseUrl: 'https://llm.example.com/v1',
      engine: { customFetch },
    });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('completed');
    expect(calls[0]).toEqual({ url: 'https://llm.example.com/v1/chat/completions', auth: `Bearer ${keyFor('custom')}` });
    expect(await h.latestRun()).toMatchObject({ provider: 'custom', model: 'llama-3.3' });
  });

  it('fails the review, without any call, when the custom host now resolves to a private address', async () => {
    const customFetch = vi.fn(async () => reviewStream());
    const h = createHarness({
      settings: { provider: 'custom', model: 'llama-3.3' },
      customBaseUrl: 'https://llm.example.com/v1',
      engine: { customFetch, publicIp: '169.254.169.254' },
    });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('private or loopback');
    expect(customFetch).not.toHaveBeenCalled();
    expect(result.detail).not.toContain(keyFor('custom'));
  });

  it('leaves out a custom fallback whose stored URL now fails the check, discloses it and finishes the review', async () => {
    const customFetch = vi.fn(async () => reviewStream());
    vi.stubGlobal('fetch', vi.fn(async () => reviewStream()));
    try {
      const h = createHarness({
        settings: { provider: 'openrouter', model: 'openai/gpt-5', fallback: [{ provider: 'custom', model: 'llama-3.3' }] },
        customBaseUrl: 'https://llm.example.com/v1',
        engine: { customFetch, publicIp: '10.0.0.9' },
      });
      const result = await processReviewJob(h.job, h.deps);
      expect(result.status).toBe('completed');
      expect(customFetch).not.toHaveBeenCalled();
      expect((await h.latestRun())?.detail).toContain('fallback custom:llama-3.3 skipped');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


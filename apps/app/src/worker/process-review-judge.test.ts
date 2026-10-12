import { describe, expect, it, vi } from 'vitest';
import { Secret, type ReviewModel } from '@mergepilot/engine';
import type { Logger } from 'pino';
import type { JudgeSettings, KeyProvider } from '../core/types.js';
import { createHarness, keyFor } from './model-settings.fixtures.js';
import { processReviewJob } from './process-review.js';

const finding = (title: string, line: number) => ({
  path: 'src/main.ts',
  line,
  side: 'RIGHT',
  title,
  body: `${title} body`,
  severity: 'high',
  category: 'correctness',
  evidence: 'b',
  confidence: 0.9,
});

const model: ReviewModel = {
  label: 'test-model',
  generate: vi.fn(async () => ({
    text: JSON.stringify({ summary: 'Two issues', findings: [finding('Real bug', 2), finding('Nitpick', 1)] }),
    finishReason: 'stop' as const,
    usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })),
};

const judgeSettings = (overrides: Partial<JudgeSettings> = {}): JudgeSettings => ({
  enabled: true,
  provider: 'typesafe',
  model: 'jev-latest',
  mode: 'filter',
  threshold: 0.35,
  fallback: [],
  ...overrides,
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
const answers = (values: Record<string, number>) =>
  json(200, {
    answers: Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }])),
    usage: { input_tokens: 120, output_tokens: 0 },
  });

function setup(judge: JudgeSettings, judgeFetch: (url: string) => Response, noKeyFor: KeyProvider[] = []) {
  const h = createHarness({ settings: { judge, minSeverity: 'low' }, fakeModel: model });
  h.credentials.resolve.mockImplementation(async (_ws: string, provider: string) => {
    if (noKeyFor.includes(provider as KeyProvider)) throw new Error('no key');
    return new Secret(keyFor(provider));
  });
  const info = vi.fn();
  const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const fetchSpy = vi.fn(async (url: string) => judgeFetch(url));
  h.deps.judgeFetch = fetchSpy;
  h.deps.logger = logger;
  return { ...h, info, fetchSpy };
}

describe('processReviewJob — Jev judge (ADR-0015)', () => {
  it('skips a keyless fallback, moves past a failed primary, filters and records every attempt', async () => {
    const h = setup(
      judgeSettings({ fallback: [{ provider: 'vercel-gateway', model: 'typesafe-ai/jev' }, { provider: 'opencode-zen', model: 'jev-1.13-free' }] }),
      (url) => (url.includes('typesafe.ai') ? json(401, { error: { message: 'bad key' } }) : answers({ f1: 0.9, f2: 0.1 })),
      ['vercel-gateway'],
    );
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('completed');
    expect(h.fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'https://api.typesafe.ai/v1/systemone',
      'https://opencode.ai/zen/v1/systemone',
    ]);

    const run = await h.latestRun();
    const judge = run?.result?.judge;
    expect(judge?.filtered.map((f) => f.title)).toEqual(['Nitpick']);
    expect(judge?.answeredBy).toBe('opencode-zen:jev-1.13-free (fallback 2; typesafe failed: auth; vercel-gateway skipped: no-key)');
    expect(judge?.attempts.map((a) => [a.provider, a.ok, a.code ?? null])).toEqual([
      ['typesafe', false, 'auth'],
      ['vercel-gateway', false, 'no-key'],
      ['opencode-zen', true, null],
    ]);
    expect(judge?.inputTokens).toBe(120);
    expect(run?.result?.usage?.inputTokens).toBeGreaterThanOrEqual(170);
    expect(run?.result?.findings.map((f) => f.title)).toEqual(['Real bug']);

    const summary = String(h.reviews[0]?.body);
    expect(summary).toContain('Jev: `opencode-zen:jev-1.13-free (fallback 2;');
    expect(summary).toContain('Filtered by Jev (1)');

    const calls = h.info.mock.calls.filter(([fields]) => (fields as { event?: string }).event === 'judge.call');
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls)).not.toContain('Nitpick body');
    expect(JSON.stringify(calls)).not.toContain(keyFor('typesafe'));
  });

  it('publishes unfiltered and discloses it when every judge entry fails', async () => {
    const h = setup(judgeSettings(), () => json(503, { error: { message: 'down' } }));
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('completed');
    const run = await h.latestRun();
    expect(run?.result?.findings).toHaveLength(2);
    expect(run?.result?.judge?.unavailable).toBe('server');
    expect(run?.detail).toContain('Jev judge unavailable: server');
    expect(String(h.reviews[0]?.body)).toContain('Jev judge unavailable: server');
  });

  it('does not call the judge when it is disabled', async () => {
    const h = setup(judgeSettings({ enabled: false }), () => answers({}));
    await processReviewJob(h.job, h.deps);
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect((await h.latestRun())?.result?.judge).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergePilotConfigSchema, type MergePilotConfig } from '../config/schema.js';
import { LlmFailure } from '../llm/failure.js';
import type { TokenUsage } from '../llm/types.js';
import { OpenAICompatibleAdapter } from '../providers/compatible/adapter.js';
import { mockFetch, sseResponse } from '../providers/fetch-mock.fixtures.js';
import { estimateTokens } from './budget.js';
import { modelFromAdapter, type ReviewModel, type ReviewModelRequest, type ReviewModelResponse } from './model.js';
import { makeAnswerJson, makeConfig, validFindingJson } from './pipeline.fixtures.js';
import { runReview, type PrFile } from './pipeline.js';
import { PATCH_TRUNCATED_NOTE } from './split.js';

/** ~100 diff tokens of added lines, anchored from line 1. */
function patchOf(lines = 25): string {
  const added = Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`);
  return [`@@ -0,0 +1,${lines} @@`, ...added].join('\n');
}

const fiveFiles: PrFile[] = Array.from({ length: 5 }, (_, i) => ({
  path: `src/f${i}.ts`,
  status: 'added',
  patch: patchOf(),
  changes: 25,
}));

function hugeConfig(review: Partial<MergePilotConfig['review']> = {}, budget?: MergePilotConfig['budget']): MergePilotConfig {
  const base = makeConfig();
  return makeConfig({
    review: { ...base.review, maxPromptTokens: 1, batchTokens: 250, ...review },
    ...(budget ? { budget } : {}),
  });
}

function usage(outputTokens: number): TokenUsage {
  return { inputTokens: 10, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Answers per call; `answer` sees the request and how many calls came before. */
function scripted(
  answer: (req: ReviewModelRequest, index: number) => Promise<ReviewModelResponse> | ReviewModelResponse,
): { model: ReviewModel; calls: ReviewModelRequest[] } {
  const calls: ReviewModelRequest[] = [];
  const model: ReviewModel = {
    label: 'zai-coding:glm-5.3',
    outputTokensFor: (max) => max,
    generate: async (req) => {
      calls.push(req);
      return answer(req, calls.length - 1);
    },
  };
  return { model, calls };
}

function answerFor(req: ReviewModelRequest): ReviewModelResponse {
  const path = /src\/f\d\.ts/.exec(req.user)?.[0] ?? 'src/f0.ts';
  return {
    text: JSON.stringify({ summary: `Reviewed ${path}.`, findings: [validFindingJson({ path, line: 2, title: `Bug in ${path}` })] }),
    finishReason: 'stop',
    usage: usage(100),
  };
}

const run = (config: MergePilotConfig, model: ReviewModel, files: PrFile[] = fiveFiles, fallbackModels?: ReviewModel[]) =>
  runReview({
    config,
    pr: { title: 'Huge PR', body: '' },
    files,
    rulesFiles: [],
    model,
    knownSecrets: [],
    ...(fallbackModels ? { fallbackModels } : {}),
  });

describe('runReview — huge PRs (ADR-0013)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the whole-PR call above maxPromptTokens and fills batches up to batchTokens', async () => {
    const { model, calls } = scripted((req) => answerFor(req));
    const result = await run(hugeConfig(), model);

    // 5 files of ~100 tokens, cap 250 → [f0,f1] [f2,f3] [f4]; no call carries every file.
    expect(calls).toHaveLength(3);
    const filesPerCall = calls.map((c) => fiveFiles.filter((f) => c.user.includes(f.path)).map((f) => f.path));
    expect(filesPerCall).toEqual([['src/f0.ts', 'src/f1.ts'], ['src/f2.ts', 'src/f3.ts'], ['src/f4.ts']]);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(true);
      expect(result.usage?.outputTokens).toBe(300);
    }
  });

  it('reviews a ~380k-token PR in capped batches with the default budget instead of skipping it', async () => {
    // eyadex#78: 312 files, about 380,000 prompt tokens, skipped under the old 200,000 default.
    const files: PrFile[] = Array.from({ length: 312 }, (_, i) => ({
      path: `src/m${i}.ts`,
      status: 'added',
      patch: patchOf(260),
      changes: 260,
    }));
    const config = MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'claude-test', language: 'en' });
    const { model, calls } = scripted(() => ({ text: makeAnswerJson([]), finishReason: 'stop' }));

    const result = await run(config, model, files);

    expect(estimateTokens(files.map((f) => f.patch).join(''))).toBeGreaterThan(370_000);
    expect(result.status).toBe('completed');
    expect(calls.length).toBeGreaterThan(10);
    // Every call stays bounded: no single call carries the whole PR.
    expect(calls.every((c) => estimateTokens(c.system + c.user) < config.review.maxPromptTokens)).toBe(true);
  });

  it('keeps the single whole-PR call when the prompt fits maxPromptTokens', async () => {
    const { model, calls } = scripted(() => ({ text: makeAnswerJson(), finishReason: 'stop' }));
    await run(hugeConfig({ maxPromptTokens: 60_000 }), model);
    expect(calls).toHaveLength(1);
    expect(fiveFiles.every((f) => calls[0]?.user.includes(f.path))).toBe(true);
  });

  it('reviews a file bigger than the cap alone, truncated, and names it in incompleteReasons', async () => {
    const files: PrFile[] = [
      { path: 'src/f0.ts', status: 'added', patch: patchOf(), changes: 25 },
      { path: 'src/huge.ts', status: 'added', patch: patchOf(2000), changes: 2000 },
    ];
    const { model, calls } = scripted((req) => answerFor(req));
    const result = await run(hugeConfig({ batchTokens: 500 }), model, files);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.user).toContain(PATCH_TRUNCATED_NOTE);
    expect(calls[1]?.user.length).toBeLessThan(patchOf(2000).length);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons).toContain('src/huge.ts: patch truncated to fit review.batchTokens');
    }
  });

  it('retries an empty reply once with thinking off and discloses nothing when the retry answers', async () => {
    const { model, calls } = scripted((_req, i) =>
      i === 0 ? { text: '', finishReason: 'stop', usage: usage(4096) } : { text: makeAnswerJson(), finishReason: 'stop', usage: usage(200) },
    );
    const result = await run(makeConfig(), model, [fiveFiles[0]!]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toHaveProperty('thinking');
    expect(calls[1]?.thinking).toBe('off');
    expect(calls[1]?.user).toBe(calls[0]?.user);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(true);
      expect(result.usage?.outputTokens).toBe(4296);
    }
  });

  it('sends GLM thinking disabled on the retry through the compatible adapter', async () => {
    const empty = sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
    const answered = sseResponse([
      { choices: [{ delta: { content: makeAnswerJson() }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
    const { fetch, calls } = mockFetch(empty, answered);
    const adapter = new OpenAICompatibleAdapter({ provider: 'zai-coding', apiKey: ['k', 'test'].join('-'), fetch });
    const result = await run(makeConfig(), modelFromAdapter(adapter, 'glm-5.3', 'on'), [fiveFiles[0]!]);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ thinking: { type: 'enabled' } });
    expect(calls[1]?.body).toMatchObject({ thinking: { type: 'disabled' } });
    expect(result.status).toBe('completed');
  });

  it('reports a batch that stays empty after the retry and still merges the other batches', async () => {
    const { model, calls } = scripted((req) =>
      req.user.includes('src/f0.ts') ? { text: '', finishReason: 'stop' } : answerFor(req),
    );
    const result = await run(hugeConfig(), model);

    expect(calls.filter((c) => c.user.includes('src/f0.ts')).map((c) => c.thinking)).toEqual([undefined, 'off']);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons).toContain(
        'batch 1 (src/f0.ts, src/f1.ts): empty-response: model returned no text (also with thinking off)',
      );
      const titles = [...result.inline, ...result.summaryOnly].map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining(['Bug in src/f2.ts', 'Bug in src/f4.ts']));
    }
  });

  it('fails only when no batch produced an answer, with every batch disclosed', async () => {
    const { model } = scripted(() => ({ text: '', finishReason: 'stop' }));
    const result = await run(hugeConfig(), model);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('no batch produced an answer (3 batches)');
      expect(result.detail).toContain('batch 1 (src/f0.ts, src/f1.ts): empty-response');
      expect(result.detail).toContain('batch 3 (src/f4.ts): empty-response');
    }
  });

  it('fails a call that exceeds callTimeoutMs with TIMEOUT', async () => {
    vi.useFakeTimers();
    const { model } = scripted(() => new Promise<ReviewModelResponse>(() => undefined));
    const pending = run(hugeConfig({ maxPromptTokens: 60_000, callTimeoutMs: 1_000 }), model, [fiveFiles[0]!]);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', reason: 'TIMEOUT' });
  });

  it('a timed-out batch is disclosed and the others still count', async () => {
    vi.useFakeTimers();
    const { model } = scripted((req) =>
      req.user.includes('src/f2.ts') ? new Promise<ReviewModelResponse>(() => undefined) : answerFor(req),
    );
    const pending = run(hugeConfig({ callTimeoutMs: 1_000 }), model);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result.incompleteReasons).toContain('batch 2 (src/f2.ts, src/f3.ts): TIMEOUT');
    }
  });

  it('a timeout is a disclosed fallback trigger, never a silent switch (ADR-0008)', async () => {
    vi.useFakeTimers();
    const { model: primary } = scripted(() => new Promise<ReviewModelResponse>(() => undefined));
    const fallback: ReviewModel = { label: 'openai:gpt-test', generate: async () => ({ text: makeAnswerJson(), finishReason: 'stop' }) };
    const pending = run(hugeConfig({ maxPromptTokens: 60_000, callTimeoutMs: 1_000 }), primary, [fiveFiles[0]!], [fallback]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toMatchObject({
      status: 'completed',
      modelUsed: 'openai:gpt-test',
      fallbackFrom: 'zai-coding:glm-5.3',
      fallbackCode: 'network',
    });
  });

  it('stops starting batches at totalTimeoutMs and finishes with what is done', async () => {
    vi.useFakeTimers();
    const { model, calls } = scripted((req) => {
      vi.setSystemTime(Date.now() + 600);
      return answerFor(req);
    });
    const result = await run(hugeConfig({ totalTimeoutMs: 1_000 }), model);

    expect(calls).toHaveLength(2);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons).toEqual([
        'time limit reached: 2 of 3 batches reviewed',
        'batch 3 (src/f4.ts): skipped: time limit reached',
      ]);
    }
  });

  it('sums usage and spend across the empty-reply retry and the batches', async () => {
    const pricing = { inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
    const { model, calls } = scripted((req, i) =>
      req.user.includes('src/f0.ts') && i === 0 ? { text: '', finishReason: 'stop', usage: usage(4096) } : answerFor(req),
    );
    const result = await run(hugeConfig({}, { perReviewUsd: 1, maxInputTokens: 200_000, pricing }), model);

    expect(calls).toHaveLength(4);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(true);
      expect(result.usage?.outputTokens).toBe(4096 + 300);
      expect(result.costUsd).toBeCloseTo(((4096 + 300) * 10) / 1_000_000, 10);
    }
  });

  it('retries an empty verification reply with thinking off', async () => {
    const verdicts = JSON.stringify({ verdicts: [{ id: 'f1', verdict: 'confirmed', reason: 'shown' }] });
    const { model, calls } = scripted((_req, i) => {
      if (i === 0) return { text: makeAnswerJson([validFindingJson({ path: 'src/f0.ts', line: 2 })]), finishReason: 'stop' };
      if (i === 1) return { text: '', finishReason: 'stop' };
      return { text: verdicts, finishReason: 'stop' };
    });
    const result = await run(hugeConfig({ maxPromptTokens: 60_000, verify: true }), model, [fiveFiles[0]!]);

    expect(calls.map((c) => c.thinking)).toEqual([undefined, undefined, 'off']);
    expect(result).toMatchObject({ status: 'completed', complete: true, verification: { checked: 1, rejected: 0 } });
  });

  it('maps a thrown TIMEOUT failure to a failed review with its code', async () => {
    const failing: ReviewModel = {
      label: 'fake:fail',
      generate: async () => {
        throw new LlmFailure({ code: 'TIMEOUT', provider: 'fake', message: 'took too long' });
      },
    };
    const result = await run(hugeConfig({ maxPromptTokens: 60_000 }), failing, [fiveFiles[0]!]);
    expect(result).toMatchObject({ status: 'failed', reason: 'TIMEOUT', detail: 'took too long' });
  });
});

import { describe, expect, it } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { LlmFailure } from '../llm/failure.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { makeConfig, validFindingJson } from './pipeline.fixtures.js';
import { runReview, type PrFile } from './pipeline.js';

// review.maxFindings reaches every call of a review and caps the review's total (ADR-0033).

function patchOf(lines: number): string {
  const added = Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`);
  return [`@@ -0,0 +1,${lines} @@`, ...added].join('\n');
}

/** A model that answers `perCall` distinct findings on the first file its prompt shows. */
function findingsModel(perCall: number): { model: ReviewModel; calls: ReviewModelRequest[] } {
  const calls: ReviewModelRequest[] = [];
  const model: ReviewModel = {
    label: 'fake:test',
    outputTokensFor: (max) => max,
    generate: async (req): Promise<ReviewModelResponse> => {
      calls.push(req);
      const path = /PATCH:(src\/f\d+\.ts)/.exec(req.user)?.[1] ?? 'src/f0.ts';
      const findings = Array.from({ length: perCall }, (_, i) =>
        validFindingJson({ path, line: i + 1, title: `Bug ${i} in ${path}` }),
      );
      return { text: JSON.stringify({ summary: 'Reviewed.', findings }), finishReason: 'stop' };
    },
  };
  return { model, calls };
}

function configWith(review: Partial<MergePilotConfig['review']>): MergePilotConfig {
  const base = makeConfig();
  return makeConfig({ review: { ...base.review, ...review } });
}

const review = (config: MergePilotConfig, model: ReviewModel, files: PrFile[]) =>
  runReview({ config, pr: { title: 'PR', body: '' }, files, rulesFiles: [], model, knownSecrets: [] });

describe('runReview — review.maxFindings', () => {
  it('asks for 50 findings with an answer budget sized for them and keeps 50', async () => {
    const { model, calls } = findingsModel(60);
    const files: PrFile[] = [{ path: 'src/f0.ts', status: 'added', patch: patchOf(60), changes: 60 }];

    const result = await review(configWith({ maxFindings: 50 }), model, files);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain('Return at most 50 findings.');
    expect(calls[0]?.maxOutputTokens).toBe(16_024);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.result.findings).toHaveLength(50);
  });

  it('discloses when the model output limit leaves less answer room than the limit needs', async () => {
    const { model } = findingsModel(5);
    const limited: ReviewModel = { ...model, answerTokensFor: (max) => Math.min(max, 6000) };
    const files: PrFile[] = [{ path: 'src/f0.ts', status: 'added', patch: patchOf(10), changes: 10 }];

    const clamped = await review(configWith({ maxFindings: 50 }), limited, files);
    expect(clamped.status).toBe('completed');
    if (clamped.status === 'completed') {
      expect(clamped.outputLimit).toEqual({ maxFindings: 50, answerTokens: 6000, neededTokens: 16_024 });
      // A disclosure, not an incomplete review.
      expect(clamped.complete).toBe(true);
    }

    const roomy = await review(configWith({ maxFindings: 10 }), limited, files);
    expect(roomy.status === 'completed' && roomy.outputLimit).toBeUndefined();
  });

  describe('a truncated whole-PR answer on a model clamped by its output limit', () => {
    const files: PrFile[] = [0, 1].map((i) => ({ path: `src/f${i}.ts`, status: 'added', patch: patchOf(10), changes: 10 }));
    const isWholePr = (req: ReviewModelRequest) => req.user.includes('PATCH:src/f0.ts') && req.user.includes('PATCH:src/f1.ts');

    /** Truncates every whole-PR answer; each one-file batch answers in full. */
    function truncatingModel(answerTokensFor?: (max: number) => number) {
      const { model, calls } = findingsModel(1);
      const truncating: ReviewModel = {
        ...model,
        ...(answerTokensFor ? { answerTokensFor } : {}),
        generate: async (req) => {
          if (!isWholePr(req)) return model.generate(req);
          calls.push(req);
          return { text: '{"summary": "Reviewed.", "findings": [', finishReason: 'length' };
        },
      };
      return { model: truncating, calls };
    }

    it('skips the same-size retry and goes straight to the batch split', async () => {
      // An 8,192-token model with 2,048 tokens of thinking headroom: every call gets 6,144.
      const { model, calls } = truncatingModel((max) => Math.min(max, 6144));
      const result = await review(configWith({ maxFindings: 50 }), model, files);

      expect(calls.filter(isWholePr)).toHaveLength(1);
      expect(calls.filter((c) => !isWholePr(c))).toHaveLength(2);
      expect(result.status).toBe('completed');
      if (result.status === 'completed') {
        expect(result.result.findings).toHaveLength(2);
        expect(result.outputLimit).toMatchObject({ answerTokens: 6144 });
      }
    });

    describe('after the thinking-off retry', () => {
      // An 8,192-token limit beside 2,048 tokens of thinking headroom; a thinking-off call gets it all.
      const answerTokensFor = (max: number, thinking?: 'off') => Math.min(max, thinking === 'off' ? 8192 : 6144);
      const truncated: ReviewModelResponse = { text: '{"summary": "Reviewed.", "findings": [', finishReason: 'length' };

      /** Answers empty with thinking on, truncated on the first thinking-off call, in full after. */
      function thinkingOffModel(isTarget: (req: ReviewModelRequest) => boolean, others?: (req: ReviewModelRequest) => ReviewModelResponse) {
        const { model, calls } = findingsModel(1);
        const seen = new Set<string>();
        const tracked: ReviewModel = {
          ...model,
          answerTokensFor,
          generate: async (req) => {
            if (!isTarget(req)) {
              if (others) {
                calls.push(req);
                return others(req);
              }
              return model.generate(req);
            }
            if (req.thinking !== 'off') {
              calls.push(req);
              return { text: '', finishReason: 'stop' };
            }
            if (!seen.has(req.user)) {
              seen.add(req.user);
              calls.push(req);
              return truncated;
            }
            return model.generate(req);
          },
        };
        return { model: tracked, calls };
      }

      it('retries the whole PR with thinking off when that leaves more answer room', async () => {
        // N = 20: 7,024 answer tokens; the thinking-off first answer got them all, its retry gets 8,192.
        const { model, calls } = thinkingOffModel(isWholePr);
        const result = await review(configWith({ maxFindings: 20 }), model, files);

        expect(calls.filter(isWholePr).map((c) => [c.maxOutputTokens, c.thinking])).toEqual([
          [7024, undefined],
          [7024, 'off'],
          [14_048, 'off'],
        ]);
        expect(calls.filter((c) => !isWholePr(c))).toHaveLength(0);
        expect(result.status).toBe('completed');
      });

      it('retries a truncated batch with thinking off when that leaves more answer room', async () => {
        // The whole-PR answer is truncated with thinking on: its retry would get no more room.
        const { model, calls } = thinkingOffModel((req) => !isWholePr(req), () => truncated);
        const result = await review(configWith({ maxFindings: 20 }), model, files);

        expect(calls.filter(isWholePr)).toHaveLength(1);
        const batchCalls = calls.filter((c) => !isWholePr(c));
        // Per batch: the empty answer, the truncated thinking-off answer, then its thinking-off retry.
        const perBatch = [[7024, undefined], [7024, 'off'], [14_048, 'off']];
        expect(batchCalls.map((c) => [c.maxOutputTokens, c.thinking])).toEqual([...perBatch, ...perBatch]);
        expect(result.status).toBe('completed');
        if (result.status === 'completed') expect(result.result.findings).toHaveLength(2);
      });
    });

    it('still retries the whole PR once when the retry gets more room', async () => {
      const { model, calls } = truncatingModel();
      await review(configWith({ maxFindings: 50 }), model, files);
      expect(calls.filter(isWholePr).map((c) => c.maxOutputTokens)).toEqual([16_024, 32_048]);
    });
  });

  it('discloses the output limit of the model that answered, not of the failed primary', async () => {
    const files: PrFile[] = [{ path: 'src/f0.ts', status: 'added', patch: patchOf(10), changes: 10 }];
    const failing = (answerTokensFor?: (max: number) => number): ReviewModel => ({
      label: 'fake:primary',
      outputTokensFor: (max) => max,
      ...(answerTokensFor ? { answerTokensFor } : {}),
      generate: async () => {
        throw new LlmFailure({ code: 'RATE_LIMIT', provider: 'fake', message: 'rate limited' });
      },
    });
    const answering = (answerTokensFor?: (max: number) => number): ReviewModel => ({
      ...findingsModel(1).model,
      label: 'fake:fallback',
      ...(answerTokensFor ? { answerTokensFor } : {}),
    });
    const run = (primary: ReviewModel, fallback: ReviewModel) =>
      runReview({ config: configWith({ maxFindings: 50 }), pr: { title: 'PR', body: '' }, files, rulesFiles: [], model: primary, fallbackModels: [fallback], knownSecrets: [] });

    const roomyFallback = await run(failing((max) => Math.min(max, 6000)), answering());
    expect(roomyFallback.status === 'completed' && roomyFallback.modelUsed).toBe('fake:fallback');
    expect(roomyFallback.status === 'completed' && roomyFallback.outputLimit).toBeUndefined();

    const clampedFallback = await run(failing(), answering((max) => Math.min(max, 7000)));
    expect(clampedFallback.status === 'completed' && clampedFallback.outputLimit).toMatchObject({ answerTokens: 7000 });
  });

  it('sizes the verification answer for the findings it checks', async () => {
    const { model, calls } = findingsModel(50);
    const files: PrFile[] = [{ path: 'src/f0.ts', status: 'added', patch: patchOf(50), changes: 50 }];
    await review(configWith({ maxFindings: 50, verify: true }), model, files);
    // The review call, then the verification call over its 50 findings (128 tokens each).
    expect(calls.map((c) => c.maxOutputTokens).slice(0, 2)).toEqual([16_024, 6400]);
  });

  it('asks every batch for maxFindings and caps the batched review at the same total', async () => {
    const { model, calls } = findingsModel(3);
    const files: PrFile[] = Array.from({ length: 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      status: 'added',
      patch: patchOf(25),
      changes: 25,
    }));

    const result = await review(configWith({ maxFindings: 4, maxPromptTokens: 1, batchTokens: 250 }), model, files);

    // Three batches answer 3 findings each: 9 found, 4 published for the bot's one review.
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.system.includes('Return at most 4 findings.'))).toBe(true);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.result.findings).toHaveLength(4);
  });
});

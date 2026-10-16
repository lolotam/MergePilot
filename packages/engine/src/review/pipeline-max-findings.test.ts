import { describe, expect, it } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
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

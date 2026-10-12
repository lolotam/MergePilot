import { describe, expect, it } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import type { ReviewModel, ReviewModelResponse } from '../review/model.js';
import { runAudit } from './run.js';

const PRICING = { inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };

function config(budget: MergePilotConfig['budget']): MergePilotConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    language: 'en',
    review: {
      maxFindings: 5,
      minSeverity: 'medium',
      exclude: [],
      rulesFiles: [],
      pathInstructions: [],
      verify: false,
      libraryDocs: { source: 'none', maxCharsPerLibrary: 8000, maxLibraries: 5 },
    },
    budget,
    audit: { enabled: true, output: 'summary', maxFiles: 200, include: ['**/*'], exclude: [] },
  };
}

function model(
  answers: Array<() => ReviewModelResponse>,
  outputTokensFor?: (max: number) => number,
): { model: ReviewModel; requested: number[] } {
  const requested: number[] = [];
  return {
    requested,
    model: {
      label: 'fake:audit',
      ...(outputTokensFor ? { outputTokensFor } : {}),
      generate: async (req) => {
        requested.push(req.maxOutputTokens);
        const next = answers[requested.length - 1];
        if (!next) throw new Error('unexpected call');
        return next();
      },
    },
  };
}

const cut = (): ReviewModelResponse => ({ text: '{"summary": "cut', finishReason: 'max-tokens' });
const input = { rulesFiles: [], readFile: async () => 'const x = 1;', files: [{ path: 'src/a.ts', size: 20 }] };

describe('runAudit — chunk truncation retry (ADR-0011)', () => {
  it('skips the retry with a recorded reason when it does not fit perReviewUsd (thinking headroom priced)', async () => {
    // First call 4096+8192 → $0.12288; retry 8192+8192 → $0.16384; total $0.28672 > $0.25.
    // Without headroom the retry ($0.08192) would have fit.
    const m = model([cut], (max) => max + 8192);
    const result = await runAudit({
      ...input,
      config: config({ perReviewUsd: 0.25, maxInputTokens: 200000, pricing: PRICING }),
      model: m.model,
    });
    expect(m.requested).toEqual([4096]);
    expect(result.failedChunks).toHaveLength(1);
    expect(result.failedChunks[0]?.error).toContain('truncation retry skipped: budget limit reached');
  });

  it('records a failed retry in the chunk error instead of swallowing it', async () => {
    const m = model([
      cut,
      () => {
        throw Object.assign(new Error('nope'), { code: 'rate-limit' });
      },
    ]);
    const result = await runAudit({
      ...input,
      config: config({ perReviewUsd: 0.5, maxInputTokens: 200000 }),
      model: m.model,
    });
    expect(m.requested).toEqual([4096, 8192]);
    expect(result.failedChunks[0]?.error).toMatch(/^truncated/);
    expect(result.failedChunks[0]?.error).toContain('truncation retry failed: rate-limit');
  });

  it('does not retry an invalid (finished) answer', async () => {
    const m = model([() => ({ text: '{"summary": "x", "findings": [', finishReason: 'stop' })]);
    const result = await runAudit({
      ...input,
      config: config({ perReviewUsd: 0.5, maxInputTokens: 200000 }),
      model: m.model,
    });
    expect(m.requested).toEqual([4096]);
    expect(result.failedChunks[0]?.error).toMatch(/^invalid-json/);
  });
});

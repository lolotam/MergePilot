import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { LlmFailure } from '../llm/failure.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import {
  makeAnswerJson,
  makeConfig,
  SIMPLE_PATCH,
  validFindingJson,
} from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

function makeVerifyAnswerJson(verdicts: Array<{ id: string; verdict: 'confirmed' | 'plausible' | 'rejected'; reason: string }>): string {
  return JSON.stringify({ verdicts });
}

describe('runReview â€” verification pass', () => {
  it('drops rejected findings and records verification stats', async () => {
    const f1 = validFindingJson({ id: 'f1', title: 'Bug 1' });
    const f2 = validFindingJson({ id: 'f2', title: 'Bug 2', line: 2 });
    const reviewAnswer = JSON.stringify({
      summary: 'Found 2 issues.',
      findings: [f1, f2],
    });
    const verifyAnswer = makeVerifyAnswerJson([
      { id: 'f1', verdict: 'confirmed', reason: 'Confirmed bug' },
      { id: 'f2', verdict: 'rejected', reason: 'Style preference only' },
    ]);

    const calls: ReviewModelRequest[] = [];
    const model: ReviewModel = {
      label: 'fake:two-step',
      generate: async (req: ReviewModelRequest): Promise<ReviewModelResponse> => {
        calls.push(req);
        if (calls.length === 1) {
          return { text: reviewAnswer, finishReason: 'stop' };
        }
        return { text: verifyAnswer, finishReason: 'stop' };
      },
    };

    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(calls).toHaveLength(2);
      // f2 was rejected, only f1 kept
      const allFindings = [...result.inline, ...result.summaryOnly];
      expect(allFindings.map((f) => f.title)).toEqual(['Bug 1']);
      expect(result.verification).toEqual({
        checked: 2,
        rejected: 1,
      });
      expect(result.complete).toBe(true);
    }
  });

  it('confirms a finding resting on unshown code at confidence 0.69 instead of rejecting it, and lists rejections (ADR-0028)', async () => {
    const reviewAnswer = JSON.stringify({
      summary: 'Two issues.',
      findings: [
        validFindingJson({ title: 'Needs the caller', confidence: 0.85, body: 'Unsafe if src/caller.ts skips the lock; that file would confirm it.' }),
        validFindingJson({ title: 'Wrong guess', line: 2 }),
      ],
    });
    const verifyAnswer = makeVerifyAnswerJson([
      { id: 'f1', verdict: 'plausible', reason: 'The proving code is not shown.' },
      { id: 'f2', verdict: 'rejected', reason: 'The shown code contradicts it.' },
    ]);
    const answers = [reviewAnswer, verifyAnswer];
    const model: ReviewModel = {
      label: 'fake:plausible',
      generate: async (): Promise<ReviewModelResponse> => ({ text: answers.shift() ?? '', finishReason: 'stop' }),
    };

    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const kept = [...result.inline, ...result.summaryOnly];
    expect(kept.map((f) => [f.title, f.confidence])).toEqual([['Needs the caller', 0.69]]);
    expect(result.verifyRejected).toEqual([{ title: 'Wrong guess', path: 'src/index.ts', line: 2 }]);
  });

  it('bypasses verification for secret redaction findings', async () => {
    const secretValue = 'sk-ant-test-secret-value-1234';
    const secret = new Secret(secretValue);
    const patch = `@@ -1,1 +1,2 @@\n const x = 1;\n+const key = "${secretValue}";`;

    const modelFinding = validFindingJson({ id: 'f1', title: 'Normal finding' });
    const reviewAnswer = JSON.stringify({
      summary: 'Reviewed.',
      findings: [modelFinding],
    });
    const verifyAnswer = makeVerifyAnswerJson([
      { id: 'f1', verdict: 'confirmed', reason: 'Looks good' },
    ]);

    const calls: ReviewModelRequest[] = [];
    const model: ReviewModel = {
      label: 'fake:two-step',
      generate: async (req: ReviewModelRequest): Promise<ReviewModelResponse> => {
        calls.push(req);
        if (calls.length === 1) {
          return { text: reviewAnswer, finishReason: 'stop' };
        }
        return { text: verifyAnswer, finishReason: 'stop' };
      },
    };

    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch, changes: 2 }],
      rulesFiles: [],
      model,
      knownSecrets: [secret],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(calls).toHaveLength(2);
      // The verify prompt (calls[1]) must NOT contain the redaction finding id or secret finding
      expect(calls[1]?.user).not.toContain('sec1');
      expect(calls[1]?.user).not.toContain('Secret detected in patch');

      // Both the security finding and confirmed finding exist in result
      const allFindings = [...result.inline, ...result.summaryOnly];
      expect(allFindings.some((f) => f.category === 'security')).toBe(true);
      expect(allFindings.some((f) => f.title === 'Normal finding')).toBe(true);
    }
  });

  it('redacts path instructions in the review and verification prompts (ADR-0044)', async () => {
    const secretValue = 'fake-audit-token-5678-placeholder';
    const reviewAnswer = JSON.stringify({
      summary: 'Reviewed.',
      findings: [validFindingJson({ category: 'project-rule', ruleRef: '.mergepilot.yml src/**' })],
    });
    const verifyAnswer = makeVerifyAnswerJson([{ id: 'f1', verdict: 'confirmed', reason: 'Rule broken' }]);
    const calls: ReviewModelRequest[] = [];
    const model: ReviewModel = {
      label: 'fake:two-step',
      generate: async (req: ReviewModelRequest): Promise<ReviewModelResponse> => {
        calls.push(req);
        return { text: calls.length === 1 ? reviewAnswer : verifyAnswer, finishReason: 'stop' };
      },
    };
    const review = {
      ...makeConfig().review,
      verify: true,
      pathInstructions: [{ path: 'src/**', instructions: `Log every refusal; the audit key is ${secretValue}.` }],
    };

    const result = await runReview({
      config: makeConfig({ review }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [new Secret(secretValue)],
    });

    expect(result.status).toBe('completed');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.user).toContain('<<<REVIEW_CRITERIA:PATH_INSTRUCTIONS:src/**>>>');
    expect(calls[1]?.user).toContain('Log every refusal');
    for (const call of calls) {
      expect(call.system + call.user).not.toContain(secretValue);
    }
  });

  it('keeps findings and marks incomplete when verify call throws', async () => {
    const modelFinding = validFindingJson({ id: 'f1', title: 'Bug 1' });
    const reviewAnswer = JSON.stringify({
      summary: 'Reviewed.',
      findings: [modelFinding],
    });

    let callCount = 0;
    const model: ReviewModel = {
      label: 'fake:fail-verify',
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          return { text: reviewAnswer, finishReason: 'stop' };
        }
        throw new LlmFailure({
          code: 'RATE_LIMIT',
          provider: 'anthropic',
          message: 'Rate limit hit on verify call',
        });
      },
    };

    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    // Review does NOT fail
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons).toContain('verification skipped: RATE_LIMIT');
      // All findings kept
      const allFindings = [...result.inline, ...result.summaryOnly];
      expect(allFindings.map((f) => f.title)).toEqual(['Bug 1']);
      expect(result.verification).toBeUndefined();
    }
  });

  it('keeps findings and marks incomplete when verify answer cannot be parsed', async () => {
    const modelFinding = validFindingJson({ id: 'f1', title: 'Bug 1' });
    const reviewAnswer = JSON.stringify({
      summary: 'Reviewed.',
      findings: [modelFinding],
    });

    let callCount = 0;
    const model: ReviewModel = {
      label: 'fake:unparseable-verify',
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          return { text: reviewAnswer, finishReason: 'stop' };
        }
        return { text: 'Sorry, I am unable to parse this request as JSON.', finishReason: 'stop' };
      },
    };

    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(
        result.result.incompleteReasons.some((r) => r.startsWith('verification skipped:')),
      ).toBe(true);
      const allFindings = [...result.inline, ...result.summaryOnly];
      expect(allFindings.map((f) => f.title)).toEqual(['Bug 1']);
      expect(result.verification).toBeUndefined();
    }
  });

  it('makes only a single model call when verify is disabled', async () => {
    const modelFinding = validFindingJson({ id: 'f1' });
    const reviewAnswer = JSON.stringify({
      summary: 'Reviewed.',
      findings: [modelFinding],
    });

    const generateMock = vi.fn().mockResolvedValue({
      text: reviewAnswer,
      finishReason: 'stop',
    });
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: generateMock,
    };

    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: false } }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    expect(generateMock).toHaveBeenCalledTimes(1);
    if (result.status === 'completed') {
      expect(result.verification).toBeUndefined();
    }
  });

  it('makes no verify call when there are no findings from initial review', async () => {
    const generateMock = vi.fn().mockResolvedValue({
      text: makeAnswerJson([]), // 0 findings
      finishReason: 'stop',
    });
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: generateMock,
    };

    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    expect(generateMock).toHaveBeenCalledTimes(1);
    if (result.status === 'completed') {
      expect(result.verification).toBeUndefined();
    }
  });

  it('sums usage across both review and verify calls and applies pricing to total', async () => {
    const reviewAnswer = JSON.stringify({
      summary: 'Reviewed.',
      findings: [validFindingJson({ id: 'f1' })],
    });
    const verifyAnswer = makeVerifyAnswerJson([
      { id: 'f1', verdict: 'confirmed', reason: 'Confirmed' },
    ]);

    const reviewUsage = {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 2_000,
    };
    const verifyUsage = {
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 500,
    };

    let callCount = 0;
    const model: ReviewModel = {
      label: 'fake:usage',
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          return { text: reviewAnswer, usage: reviewUsage, finishReason: 'stop' };
        }
        return { text: verifyAnswer, usage: verifyUsage, finishReason: 'stop' };
      },
    };

    const result = await runReview({
      config: makeConfig({
        review: { ...makeConfig().review, verify: true },
        budget: {
          perReviewUsd: 5.0,
          maxInputTokens: 200000,
          pricing: {
            inputPerMTok: 3.0,
            outputPerMTok: 15.0,
            cacheReadPerMTok: 0.3,
            cacheWritePerMTok: 3.75,
          },
        },
      }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.usage).toEqual({
        inputTokens: 12_000,
        outputTokens: 1_500,
        cacheReadTokens: 6_000,
        cacheWriteTokens: 2_500,
      });

      // Cost calculation with pricing:
      // (12,000 * 3 + 1,500 * 15 + 6,000 * 0.3 + 2,500 * 3.75) / 1,000,000
      // = (36,000 + 22,500 + 1,800 + 9,375) / 1,000,000 = 69,675 / 1,000,000 = 0.069675
      expect(result.costUsd).toBeCloseTo(0.069675, 6);
    }
  });
});

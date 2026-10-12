import { describe, expect, it } from 'vitest';
import {
  makeAnswerJson,
  makeConfig,
  SIMPLE_PATCH,
  validFindingJson,
} from './pipeline.fixtures.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { runReview } from './pipeline.js';

describe('runReview — truncation recovery & batch splitting (P0.1)', () => {
  it('retries once with 2x output tokens when response is truncated', async () => {
    const calls: ReviewModelRequest[] = [];
    const model: ReviewModel = {
      label: 'fake:trunc-retry',
      outputTokensFor: (max) => max,
      generate: async (req) => {
        calls.push(req);
        if (calls.length === 1) {
          return {
            text: '{"summary": "Incomplete...',
            finishReason: 'max-tokens',
            usage: { inputTokens: 50, outputTokens: 4096, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
        return {
          text: makeAnswerJson(),
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.maxOutputTokens).toBe(4096);
    expect(calls[1]?.maxOutputTokens).toBe(8192);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.summary).toBe('Looks good.');
      // Usages summed: 4096 + 200 = 4296 output tokens
      expect(result.usage?.outputTokens).toBe(4296);
    }
  });

  it('falls back to splitting PR into batches when retry is still truncated', async () => {
    const calls: ReviewModelRequest[] = [];
    const patchA = '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;';
    const patchB = '@@ -1,2 +1,3 @@\n const x = 1;\n+const y = 2;\n const z = 3;';

    const model: ReviewModel = {
      label: 'fake:trunc-batch',
      outputTokensFor: (max) => max,
      generate: async (req) => {
        calls.push(req);
        // Call 1 (all files, 4096): truncated
        if (calls.length === 1) {
          return {
            text: '{"summary": "Cut off mid-way...',
            finishReason: 'max-tokens',
            usage: { inputTokens: 100, outputTokens: 4096, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
        // Call 2 (retry all files, 8192): still truncated
        if (calls.length === 2) {
          return {
            text: '{"summary": "Still cut off...',
            finishReason: 'max-tokens',
            usage: { inputTokens: 100, outputTokens: 8192, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
        // Subsequent calls are batches
        if (req.user.includes('src/a.ts')) {
          return {
            text: JSON.stringify({
              summary: 'Batch A looks good.',
              findings: [validFindingJson({ path: 'src/a.ts', line: 2, title: 'Bug in A' })],
            }),
            finishReason: 'stop',
            usage: { inputTokens: 50, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
        return {
          text: JSON.stringify({
            summary: 'Batch B has notes.',
            findings: [validFindingJson({ path: 'src/b.ts', line: 2, title: 'Bug in B' })],
          }),
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [
        { path: 'src/a.ts', status: 'modified', patch: patchA, changes: 3 },
        { path: 'src/b.ts', status: 'modified', patch: patchB, changes: 3 },
      ],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(calls.length).toBeGreaterThanOrEqual(4); // Call 1, Retry 2, Batch A 3, Batch B 4
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.summary).toContain('Batch A');
      expect(result.summary).toContain('Batch B');
      const allFindings = [...result.inline, ...result.summaryOnly];
      expect(allFindings.map((f) => f.title)).toContain('Bug in A');
      expect(allFindings.map((f) => f.title)).toContain('Bug in B');
      // Deduped and stable ids
      expect(allFindings[0]?.id).toBe('f1');
      expect(allFindings[1]?.id).toBe('f2');
      // Usage summed: 4096 + 8192 + 150 + 150 = 12588 output tokens
      expect(result.usage?.outputTokens).toBe(12588);
    }
  });

  it('simulates large PR: succeeds through batching, dedupes findings and sums usage', async () => {
    const patch1 = '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;';
    const patch2 = '@@ -1,2 +1,3 @@\n const d = 1;\n+const e = 2;\n const f = 3;';
    const patch3 = '@@ -1,2 +1,3 @@\n const g = 1;\n+const h = 2;\n const i = 3;';

    let callCount = 0;
    const model: ReviewModel = {
      label: 'fake:large-pr',
      outputTokensFor: (max) => max,
      generate: async (req) => {
        callCount++;
        // First 2 calls (initial + retry for full PR) exceed token limit
        if (callCount <= 2) {
          return {
            text: '{"summary": "Thinking tokens ate the output budget...',
            finishReason: 'max-tokens',
            usage: { inputTokens: 200, outputTokens: req.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
        // Batches succeed with finding for each file
        const fileMatch = req.user.match(/src\/file(\d)\.ts/);
        const fileNum = fileMatch ? fileMatch[1] : '1';
        return {
          text: JSON.stringify({
            summary: `Reviewed batch containing file ${fileNum}.`,
            findings: [
              validFindingJson({ path: `src/file${fileNum}.ts`, line: 2, title: `Issue in file ${fileNum}` }),
              // Duplicate finding across batches should be deduped
              validFindingJson({ path: 'src/file1.ts', line: 2, title: 'Issue in file 1' }),
            ],
          }),
          finishReason: 'stop',
          usage: { inputTokens: 80, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'Large PR', body: 'Touches multiple subsystems' },
      files: [
        { path: 'src/file1.ts', status: 'modified', patch: patch1, changes: 3 },
        { path: 'src/file2.ts', status: 'modified', patch: patch2, changes: 3 },
        { path: 'src/file3.ts', status: 'modified', patch: patch3, changes: 3 },
      ],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const allFindings = [...result.inline, ...result.summaryOnly];
      // File 1 duplicate finding is deduped
      const file1Findings = allFindings.filter((f) => f.title === 'Issue in file 1');
      expect(file1Findings).toHaveLength(1);
      expect(result.complete).toBe(true);
      expect(result.usage?.inputTokens).toBeGreaterThan(0);
      expect(result.usage?.outputTokens).toBeGreaterThan(4096 + 8192);
    }
  });
});

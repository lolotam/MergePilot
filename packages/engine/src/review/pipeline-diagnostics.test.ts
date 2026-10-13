import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import type { ReviewModel, ReviewModelResponse } from './model.js';
import { runReview } from './pipeline.js';

function modelAnswering(responses: ReviewModelResponse[]): ReviewModel {
  let call = 0;
  return {
    label: 'fake:prose',
    outputTokensFor: (max) => max,
    generate: async () => {
      const response = responses[call++];
      if (!response) throw new Error(`unexpected call ${call}`);
      return response;
    },
  };
}

const oneFile = [{ path: 'src/a.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }];

describe('runReview — what an unusable answer said', () => {
  it('reports both attempts of an answer without JSON: length, finish reason, output tokens and a short preview', async () => {
    const first = 'No issues found in this diff.';
    const second = 'x'.repeat(500);
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: oneFile,
      rulesFiles: [],
      model: modelAnswering([
        { text: first, finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { text: second, finishReason: 'stop' },
      ]),
      knownSecrets: [],
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.answerAttempts).toEqual([
      { chars: first.length, finishReason: 'stop', outputTokens: 12, preview: first },
      { chars: 500, finishReason: 'stop', preview: 'x'.repeat(200) },
    ]);
  });

  it('never puts a known secret into the preview', async () => {
    const token = 'xai-oauth-token-1234567890abcdef';
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: oneFile,
      rulesFiles: [],
      model: modelAnswering([
        { text: `Sorry, token ${token} expired.`, finishReason: 'stop' },
        { text: 'Still no JSON.', finishReason: 'stop' },
      ]),
      knownSecrets: [new Secret(token)],
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.answerAttempts).toHaveLength(2);
    expect(result.answerAttempts?.[0]?.preview).toContain('Sorry, token');
    expect(JSON.stringify(result.answerAttempts)).not.toContain(token);
  });
});

import { expect, it } from 'vitest';
import type { ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

it('discloses long-label context removed by final batch fitting as left out', async () => {
  const path = `src/${'long-path-'.repeat(1000)}ref.ts`;
  const requests: ReviewModelRequest[] = [];
  const base = makeConfig();
  const result = await runReview({
    config: makeConfig({ review: { ...base.review, verify: false, maxPromptTokens: 6000, batchTokens: 3000, explore: { maxRounds: 1 } } }),
    pr: { title: 'PR', body: '' }, rulesFiles: [], knownSecrets: [],
    files: [{ path: 'src/a.ts', status: 'modified', changes: 901,
      patch: '@@ -0,0 +1,900 @@\n' + Array.from({ length: 900 }, (_, index) => `+const value${index} = ${index};`).join('\n') }],
    contextFiles: [{ path, content: 'const ref = 1;', reason: 'import', kind: 'import', forPaths: ['src/a.ts'] }],
    explore: { reader: { readFile: async () => null, listDirectory: async () => null, listPaths: async () => null } },
    model: { label: 'fake:context', generate: async (request) => {
      requests.push(request);
      return { text: request.system.includes('EXPLORATION (round') ? '{"explore":[]}' : makeAnswerJson([]), finishReason: 'stop' };
    } },
  });

  expect(result).toMatchObject({ status: 'completed', context: { sent: [], leftOut: [path] } });
  expect(requests.every((request) => !request.user.includes(path))).toBe(true);
});

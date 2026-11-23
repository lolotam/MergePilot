import { expect, it, vi } from 'vitest';
import type { ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

it('completes a review with a patchless artifact and discloses it to the model', async () => {
  const generate = vi.fn(async (_request: ReviewModelRequest) => ({
    text: makeAnswerJson([]), finishReason: 'stop' as const,
  }));
  const result = await runReview({
    config: makeConfig(),
    pr: { title: 'Update schema', body: '' },
    files: [
      { path: 'src/run.ts', status: 'added', changes: 1, patch: '@@ -0,0 +1 @@\n+run();' },
      { path: 'migrations/meta/0001_snapshot.json', status: 'added', changes: 100, additions: 100 },
    ],
    rulesFiles: [],
    model: { label: 'fake:artifacts', generate },
    knownSecrets: [],
  });
  expect(result).toMatchObject({ status: 'completed', result: { complete: true, incompleteReasons: [] } });
  const user = generate.mock.calls[0]?.[0].user ?? '';
  expect(user).toMatch(/<<<UNTRUSTED:CHANGED_BUT_NOT_SHOWN>>>[\s\S]*0001_snapshot\.json[^\n]*skip-generated/);
});

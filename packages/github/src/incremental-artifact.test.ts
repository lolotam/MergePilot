import { expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { selectIncrementalFiles } from './incremental.js';
import { buildMarker } from './marker.js';

const publisherLogin = 'mergepilot[bot]';

function select(path: string) {
  const counts = { additions: 1, deletions: 1, changes: 2 };
  const file = { path, status: 'modified', ...counts, patch: '@@ -1 +1 @@\n-before\n+after' };
  const client = {
    listReviewsPage: async () => [
      { id: 1, user: { login: publisherLogin }, body: buildMarker({ headSha: 'last-sha', configHash: 'config' }) },
    ],
    compareCommits: async () => ({
      status: 'ahead',
      files: [{ filename: path, status: 'modified', ...counts }],
    }),
  } satisfies Partial<GitHubClient>;
  return selectIncrementalFiles(client as GitHubClient, {
    owner: 'org', repo: 'repo', pull_number: 1, headSha: 'head-sha', publisherLogin, prFiles: [file],
  });
}

it('stays incremental and keeps a generated artifact in the file list without the whole-PR patch', async () => {
  const result = await select('api/openapi.json');
  expect(result.mode).toBe('incremental');
  expect(result.files).toEqual([{ path: 'api/openapi.json', status: 'modified', additions: 1, deletions: 1, changes: 2 }]);
});

it('falls back to the full review if a hand-written file has no compare patch', async () => {
  const result = await select('spec.md');
  expect(result).toMatchObject({ mode: 'full', reason: 'the new changes of spec.md are too large for the compare API' });
  expect(result.files[0]?.patch).toContain('+after');
});

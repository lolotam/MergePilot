import { expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { selectIncrementalFiles } from './incremental.js';
import { buildMarker } from './marker.js';

const publisherLogin = 'mergepilot[bot]';

function select(path: string, filesAtRef?: Record<string, string | null>) {
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
    ...(filesAtRef ? {
      getFileContent: async ({ ref, path: requestedPath }: { ref: string; path: string }) =>
        filesAtRef[`${ref}:${requestedPath}`] ?? null,
    } : {}),
  } satisfies Partial<GitHubClient>;
  return selectIncrementalFiles(client as GitHubClient, {
    owner: 'org', repo: 'repo', pull_number: 1, headSha: 'head-sha', publisherLogin, prFiles: [file],
  });
}

it('stays incremental and keeps a generated artifact patchless when incremental rebuild fails', async () => {
  const result = await select('api/openapi.json');
  expect(result.mode).toBe('incremental');
  expect(result.files).toEqual([{ path: 'api/openapi.json', status: 'modified', additions: 1, deletions: 1, changes: 2 }]);
});

it('rebuilds the incremental diff of a patchless generated artifact when contents are readable', async () => {
  const result = await select('api/openapi.json', {
    'last-sha:api/openapi.json': '{\n  "version": "1.0"\n}\n',
    'head-sha:api/openapi.json': '{\n  "version": "2.0"\n}\n',
  });
  expect(result.mode).toBe('incremental');
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.path).toBe('api/openapi.json');
  expect(result.files[0]?.patch).toContain('-  "version": "1.0"');
  expect(result.files[0]?.patch).toContain('+  "version": "2.0"');
});

it('falls back to the full review if a hand-written file has no compare patch', async () => {
  const result = await select('spec.md');
  expect(result).toMatchObject({ mode: 'full', reason: 'the new changes of spec.md are too large for the compare API' });
  expect(result.files[0]?.patch).toContain('+after');
});

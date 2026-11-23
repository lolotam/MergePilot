import { expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { selectIncrementalFiles } from './incremental.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';

const publisherLogin = 'mergepilot[bot]';

interface SelectOverrides {
  filesAtRef?: Record<string, string | null>;
  prFile?: Partial<PullRequestFile>;
  exclude?: string[];
  baseSha?: string;
  baseComparePatch?: string;
  getFileContent?: ReturnType<typeof vi.fn>;
}

function select(path: string, overrides: SelectOverrides = {}) {
  const counts = { additions: 1, deletions: 1, changes: 2 };
  const file: PullRequestFile = {
    path, status: 'modified', ...counts, patch: '@@ -1 +1 @@\n-before\n+after', ...overrides.prFile,
  };
  const { filesAtRef } = overrides;
  const getFileContent = overrides.getFileContent ?? (filesAtRef
    ? vi.fn(async ({ ref, path: requestedPath }: { ref: string; path: string }) =>
        filesAtRef[`${ref}:${requestedPath}`] ?? null)
    : undefined);
  const client = {
    listReviewsPage: async () => [
      { id: 1, user: { login: publisherLogin }, body: buildMarker({ headSha: 'last-sha', configHash: 'config' }) },
    ],
    compareCommits: async ({ head }: { head: string }) => (
      head === overrides.baseSha && overrides.baseComparePatch !== undefined
        ? { status: 'ahead', files: [{ filename: path, status: 'modified', ...counts, patch: overrides.baseComparePatch }] }
        : { status: 'ahead', files: [{ filename: path, status: 'modified', ...counts }] }
    ),
    ...(getFileContent ? { getFileContent } : {}),
  } satisfies Partial<GitHubClient>;
  return selectIncrementalFiles(client as GitHubClient, {
    owner: 'org', repo: 'repo', pull_number: 1, headSha: 'head-sha', publisherLogin, prFiles: [file],
    ...(overrides.baseSha ? { baseSha: overrides.baseSha } : {}),
    ...(overrides.exclude ? { exclude: overrides.exclude } : {}),
  });
}

it('stays incremental and keeps a generated artifact patchless when incremental rebuild fails', async () => {
  const result = await select('api/openapi.json');
  expect(result.mode).toBe('incremental');
  expect(result.files).toEqual([{ path: 'api/openapi.json', status: 'modified', additions: 1, deletions: 1, changes: 2 }]);
});

it('rebuilds the incremental diff of a patchless generated artifact when contents are readable', async () => {
  const result = await select('api/openapi.json', {
    filesAtRef: {
      'last-sha:api/openapi.json': '{\n  "version": "1.0"\n}\n',
      'head-sha:api/openapi.json': '{\n  "version": "2.0"\n}\n',
    },
  });
  expect(result.mode).toBe('incremental');
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.path).toBe('api/openapi.json');
  expect(result.files[0]?.patch).toContain('-  "version": "1.0"');
  expect(result.files[0]?.patch).toContain('+  "version": "2.0"');
});

it('reads the current path at lastMarker.headSha instead of the whole-PR rename path', async () => {
  const getFileContent = vi.fn(async ({ ref, path }: { ref: string; path: string }) => ({
    'last-sha:api/openapi.json': '{\n  "version": "1.0"\n}\n',
    'head-sha:api/openapi.json': '{\n  "version": "2.0"\n}\n',
  }[`${ref}:${path}`] ?? null));
  const result = await select('api/openapi.json', {
    prFile: { status: 'renamed', previousPath: 'old/openapi.json' },
    getFileContent,
  });
  expect(result.mode).toBe('incremental');
  expect(result.files[0]?.patch).toContain('+  "version": "2.0"');
  expect(getFileContent).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'old/openapi.json' }));
});

it('skips incremental rebuild reads for excluded generated artifacts', async () => {
  const getFileContent = vi.fn(async () => '{\n  "version": "1.0"\n}\n');
  const result = await select('api/openapi.json', { exclude: ['api/openapi.json'], getFileContent });
  expect(result.mode).toBe('incremental');
  expect(result.files[0]?.patch).toBeUndefined();
  expect(getFileContent).not.toHaveBeenCalled();
});

it('keeps the rebuilt incremental patch unfiltered when the whole-PR patch is unavailable', async () => {
  const result = await select('api/openapi.json', {
    prFile: { patch: undefined },
    baseSha: 'base-sha',
    baseComparePatch: '@@ -1,3 +1,3 @@\n {\n-  "version": "1.0"\n+  "version": "2.0"\n }',
    filesAtRef: {
      'last-sha:api/openapi.json': '{\n  "version": "1.0"\n}\n',
      'head-sha:api/openapi.json': '{\n  "version": "2.0"\n}\n',
    },
  });
  expect(result.mode).toBe('incremental');
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.patch).toContain('+  "version": "2.0"');
});

it('falls back to the full review if a hand-written file has no compare patch', async () => {
  const result = await select('spec.md');
  expect(result).toMatchObject({ mode: 'full', reason: 'the new changes of spec.md are too large for the compare API' });
  expect(result.files[0]?.patch).toContain('+after');
});

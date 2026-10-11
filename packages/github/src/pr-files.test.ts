import { describe, expect, it } from 'vitest';
import type { GitHubClient, GitHubPullRequestFile } from './client.js';
import { listPullRequestFiles } from './pr-files.js';

function createDummyFile(index: number, options?: { withPatch?: boolean; withPrevious?: boolean }): GitHubPullRequestFile {
  const file: GitHubPullRequestFile = {
    filename: `file_${index}.ts`,
    status: 'modified',
    additions: index * 2,
    deletions: index,
    changes: index * 3,
  };
  if (options?.withPatch) {
    file.patch = `@@ -1,3 +1,3 @@\n-old_${index}\n+new_${index}`;
  }
  if (options?.withPrevious) {
    file.previous_filename = `old_file_${index}.ts`;
  }
  return file;
}

describe('listPullRequestFiles', () => {
  it('handles pagination across 3 pages and maps file properties', async () => {
    const pageCalls: number[] = [];

    const fakeClient: Partial<GitHubClient> = {
      async listPullRequestFilesPage({ page }) {
        pageCalls.push(page);
        if (page === 1) {
          return Array.from({ length: 100 }, (_, i) =>
            createDummyFile(i, { withPatch: true, withPrevious: false }),
          );
        }
        if (page === 2) {
          return Array.from({ length: 100 }, (_, i) =>
            createDummyFile(100 + i, { withPatch: true, withPrevious: true }),
          );
        }
        if (page === 3) {
          return Array.from({ length: 50 }, (_, i) =>
            createDummyFile(200 + i, { withPatch: false, withPrevious: false }),
          );
        }
        return [];
      },
    };

    const result = await listPullRequestFiles(fakeClient as GitHubClient, {
      owner: 'test-org',
      repo: 'test-repo',
      pull_number: 123,
    });

    expect(pageCalls).toEqual([1, 2, 3]);
    expect(result.files).toHaveLength(250);
    expect(result.truncatedList).toBe(false);

    // Verify mapping
    const first = result.files[0];
    expect(first).toEqual({
      path: 'file_0.ts',
      status: 'modified',
      patch: '@@ -1,3 +1,3 @@\n-old_0\n+new_0',
      additions: 0,
      deletions: 0,
      changes: 0,
    });

    const fileWithPrevious = result.files[100];
    expect(fileWithPrevious?.previousPath).toBe('old_file_100.ts');

    const fileWithoutPatch = result.files[200];
    expect(fileWithoutPatch?.patch).toBeUndefined();
    expect('patch' in (fileWithoutPatch ?? {})).toBe(false);
  });

  it('3000-file cap sets truncatedList to true and stops paging', async () => {
    let pagesFetched = 0;

    const fakeClient: Partial<GitHubClient> = {
      async listPullRequestFilesPage({ page }) {
        pagesFetched = page;
        // Each page returns 100 files
        return Array.from({ length: 100 }, (_, i) =>
          createDummyFile((page - 1) * 100 + i),
        );
      },
    };

    const result = await listPullRequestFiles(fakeClient as GitHubClient, {
      owner: 'test-org',
      repo: 'test-repo',
      pull_number: 999,
    });

    expect(pagesFetched).toBe(30); // 30 pages * 100 = 3000 files
    expect(result.files).toHaveLength(3000);
    expect(result.truncatedList).toBe(true);
  });

  it('returns empty list and truncatedList false when PR has no files', async () => {
    const fakeClient: Partial<GitHubClient> = {
      async listPullRequestFilesPage() {
        return [];
      },
    };

    const result = await listPullRequestFiles(fakeClient as GitHubClient, {
      owner: 'test-org',
      repo: 'test-repo',
      pull_number: 1,
    });

    expect(result.files).toHaveLength(0);
    expect(result.truncatedList).toBe(false);
  });
});

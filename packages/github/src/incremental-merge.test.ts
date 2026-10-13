import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { selectIncrementalFiles } from './incremental.js';

// ADR-0012 amendment: a base-branch merge brings in hunks the PR did not write.
describe('selectIncrementalFiles after a base-branch merge', () => {
  const publisherLogin = 'github-actions[bot]';
  const mockPrFiles: PullRequestFile[] = [
    {
      path: 'src/main.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-incOld\n+incNew',
      additions: 2,
      deletions: 2,
      changes: 4,
    },
  ];

  it("a base-branch merge only: its hunks are not the PR's, so there is nothing new to review", async () => {
    const lastSha = 'last-sha-merge';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        // main changed src/main.ts elsewhere; the merge brought that hunk into the compare range.
        return {
          status: 'ahead',
          files: [{ filename: 'src/main.ts', status: 'modified', patch: '@@ -40 +40 @@\n-mainOld\n+mainNew', additions: 1, deletions: 1, changes: 2 }],
        };
      },
    };
    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-merge', publisherLogin, prFiles: mockPrFiles,
    });
    expect(result).toEqual({ mode: 'incremental', files: [], sinceSha: lastSha });
  });

  it("a base merge plus a real change in the same file: only the PR's own hunk is reviewed", async () => {
    const lastSha = 'last-sha-mixed';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return {
          status: 'ahead',
          files: [
            {
              filename: 'src/main.ts',
              status: 'modified',
              patch: '@@ -10 +10 @@\n-incOld\n+incNew\n@@ -40 +40 @@\n-mainOld\n+mainNew',
              additions: 2,
              deletions: 2,
              changes: 4,
            },
          ],
        };
      },
    };
    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-mixed', publisherLogin, prFiles: mockPrFiles,
    });
    expect(result.mode).toBe('incremental');
    expect(result.files.map((f) => [f.path, f.patch])).toEqual([['src/main.ts', '@@ -10 +10 @@\n-incOld\n+incNew']]);
  });
});

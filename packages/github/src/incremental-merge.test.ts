import { describe, expect, it } from 'vitest';
import type { CompareCommitsParams, GitHubClient, GitHubPullRequestFile } from './client.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { selectIncrementalFiles } from './incremental.js';

// ADR-0012 amendment: a base-branch merge brings in hunks the PR did not write.
describe('selectIncrementalFiles after a base-branch merge', () => {
  const publisherLogin = 'github-actions[bot]';
  const lastSha = 'last-sha';
  const baseSha = 'base-sha';
  const prFiles: PullRequestFile[] = [
    {
      path: 'src/main.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-incOld\n+incNew',
      additions: 2,
      deletions: 2,
      changes: 4,
    },
  ];
  // What main changed in src/main.ts since the last review (lastSha...baseSha).
  const mainChange: GitHubPullRequestFile = {
    filename: 'src/main.ts', status: 'modified', patch: '@@ -40 +40 @@\n-mainOld\n+mainNew', additions: 1, deletions: 1, changes: 2,
  };

  function clientFor(rangeFiles: GitHubPullRequestFile[]): { client: GitHubClient; calls: CompareCommitsParams[] } {
    const calls: CompareCommitsParams[] = [];
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: buildMarker({ headSha: lastSha, configHash: 'conf-1' }) }];
      },
      async compareCommits(params) {
        calls.push(params);
        return params.head === baseSha ? { status: 'diverged', files: [mainChange] } : { status: 'ahead', files: rangeFiles };
      },
    };
    return { client: client as GitHubClient, calls };
  }

  it('a merge-only push leaves nothing new to review', async () => {
    const { client, calls } = clientFor([mainChange]);
    const result = await selectIncrementalFiles(client, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-merge', publisherLogin, prFiles, baseSha,
    });
    expect(result).toEqual({ mode: 'incremental', files: [], sinceSha: lastSha });
    expect(calls.map((c) => [c.base, c.head])).toEqual([[lastSha, 'head-merge'], [lastSha, baseSha]]);
  });

  it("a merge plus a real change in the same file: only the PR's own hunk is reviewed", async () => {
    const mixed: GitHubPullRequestFile = {
      filename: 'src/main.ts',
      status: 'modified',
      patch: '@@ -10 +10 @@\n-incOld\n+incNew\n@@ -40 +40 @@\n-mainOld\n+mainNew',
      additions: 2,
      deletions: 2,
      changes: 4,
    };
    const { client } = clientFor([mixed]);
    const result = await selectIncrementalFiles(client, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-mixed', publisherLogin, prFiles, baseSha,
    });
    expect(result.files.map((f) => [f.path, f.patch])).toEqual([['src/main.ts', '@@ -10 +10 @@\n-incOld\n+incNew']]);
  });

  it('without the base commit, or when its comparison fails, every hunk is reviewed', async () => {
    const { client, calls } = clientFor([mainChange]);
    const noBase = await selectIncrementalFiles(client, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-merge', publisherLogin, prFiles,
    });
    expect(noBase.files.map((f) => f.patch)).toEqual([mainChange.patch]);
    expect(calls).toHaveLength(1);

    const failing: GitHubClient = {
      ...client,
      async compareCommits(params) {
        if (params.head === baseSha) throw new Error('compare failed');
        return { status: 'ahead', files: [mainChange] };
      },
    };
    const failed = await selectIncrementalFiles(failing, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-merge', publisherLogin, prFiles, baseSha,
    });
    expect(failed.files.map((f) => f.patch)).toEqual([mainChange.patch]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, GitHubPullRequestFile } from './client.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { selectIncrementalFiles } from './incremental.js';

describe('selectIncrementalFiles', () => {
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
    {
      path: 'src/utils.ts',
      status: 'added',
      patch: '@@ -0,0 +1,5 @@\n+export const helper = 1;',
      additions: 5,
      deletions: 0,
      changes: 5,
    },
  ];

  it('first review → full', async () => {
    const client: Partial<GitHubClient> = {
      async listReviewsPage() { return []; },
      compareCommits: vi.fn(),
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-sha-123',
      publisherLogin, prFiles: mockPrFiles,
    });

    expect(result).toEqual({ mode: 'full', files: mockPrFiles, reason: 'first review' });
    expect(client.compareCommits).not.toHaveBeenCalled();
  });

  it('same head → zero files', async () => {
    const headSha = 'head-sha-same';
    const marker = buildMarker({ headSha, configHash: 'conf-1' });
    const compareCommitsMock = vi.fn();

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      compareCommits: compareCommitsMock,
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles,
    });

    expect(result).toEqual({ mode: 'incremental', files: [], sinceSha: headSha });
    expect(compareCommitsMock).not.toHaveBeenCalled();
  });

  it('ahead → only intersecting files with compare patches', async () => {
    const lastSha = 'last-sha-111';
    const headSha = 'head-sha-222';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });

    const compareFiles: GitHubPullRequestFile[] = [
      {
        filename: 'src/main.ts',
        status: 'modified',
        patch: '@@ -10 +10 @@\n-incOld\n+incNew',
        additions: 1,
        deletions: 1,
        changes: 2,
      },
      {
        // Reverted file: changed vs lastSha, but reverted vs base so absent from prFiles
        filename: 'src/reverted.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-x\n+y',
        additions: 1,
        deletions: 1,
        changes: 2,
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits(params) {
        expect(params).toEqual({ owner: 'acme', repo: 'repo', base: lastSha, head: headSha });
        return { status: 'ahead', files: compareFiles };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles,
    });

    expect(result).toEqual({
      mode: 'incremental',
      files: [
        {
          path: 'src/main.ts',
          status: 'modified',
          patch: '@@ -10 +10 @@\n-incOld\n+incNew',
          additions: 1,
          deletions: 1,
          changes: 2,
        },
      ],
      sinceSha: lastSha,
    });
  });

  it('ahead preserves renamed file previousPath', async () => {
    const lastSha = 'last-sha-renamed';
    const headSha = 'head-sha-renamed';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });

    const prFilesWithRename: PullRequestFile[] = [
      {
        path: 'src/renamed.ts',
        status: 'renamed',
        previousPath: 'src/original.ts',
        patch: '@@ -1 +1 @@',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ];

    const compareFiles: GitHubPullRequestFile[] = [
      {
        filename: 'src/renamed.ts',
        previous_filename: 'src/original.ts',
        status: 'renamed',
        patch: '@@ -2 +2 @@',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return { status: 'ahead', files: compareFiles };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: prFilesWithRename,
    });

    expect(result).toEqual({
      mode: 'incremental',
      files: [
        {
          path: 'src/renamed.ts',
          previousPath: 'src/original.ts',
          status: 'renamed',
          patch: '@@ -2 +2 @@',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ],
      sinceSha: lastSha,
    });
  });

  it('diverged → full', async () => {
    const lastSha = 'last-sha-diverged';
    const headSha = 'head-sha-diverged';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return { status: 'diverged', files: [] };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles,
    });

    expect(result).toEqual({
      mode: 'full',
      files: mockPrFiles,
      reason: 'history rewritten since last review',
    });
  });

  it('behind → full', async () => {
    const lastSha = 'last-sha-behind';
    const headSha = 'head-sha-behind';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return { status: 'behind', files: [] };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles,
    });

    expect(result).toEqual({
      mode: 'full',
      files: mockPrFiles,
      reason: 'history rewritten since last review',
    });
  });

  it('404 → full', async () => {
    const lastSha = 'last-sha-force-pushed';
    const headSha = 'head-sha-force-pushed';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return null;
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles,
    });

    expect(result).toEqual({
      mode: 'full',
      files: mockPrFiles,
      reason: 'history rewritten since last review',
    });
  });

  it('config hash changed → full review', async () => {
    const lastSha = 'last-sha-cfg';
    const headSha = 'head-sha-cfg';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-old' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      compareCommits: vi.fn(),
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles, configHash: 'conf-new',
    });

    expect(result).toEqual({
      mode: 'full',
      files: mockPrFiles,
      reason: 'configuration changed since last review',
    });
    expect(client.compareCommits).not.toHaveBeenCalled();
  });

  it.each([300, 301])('comparison at or over the 300-file cap (%i files) → full review', async (count) => {
    const lastSha = 'last-sha-large';
    const headSha = 'head-sha-large';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        const largeFiles = Array.from({ length: count }, (_, i) => ({
          filename: `src/file-${i}.ts`,
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
        }));
        return { status: 'ahead', files: largeFiles, totalCommits: 5 };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles, configHash: 'conf-1',
    });

    expect(result).toEqual({
      mode: 'full',
      files: mockPrFiles,
      reason: 'comparison too large',
    });
  });

  it('ahead returns commitCount when compare reports totalCommits', async () => {
    const lastSha = 'last-sha-commits';
    const headSha = 'head-sha-commits';
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
              patch: '@@ -1 +1 @@',
              additions: 1,
              deletions: 1,
              changes: 2,
            },
          ],
          totalCommits: 3,
        };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles, configHash: 'conf-1',
    });

    expect(result).toEqual({
      mode: 'incremental',
      files: [
        {
          path: 'src/main.ts',
          status: 'modified',
          patch: '@@ -1 +1 @@',
          additions: 1,
          deletions: 1,
          changes: 2,
        },
      ],
      sinceSha: lastSha,
      commitCount: 3,
    });
  });

  it('compare API error → full review (comparison unavailable)', async () => {
    const marker = buildMarker({ headSha: 'last-sha', configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      compareCommits: vi.fn(async () => {
        throw new Error('502 Bad Gateway');
      }),
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-sha',
      publisherLogin, prFiles: mockPrFiles, configHash: 'conf-1',
    });

    expect(result).toEqual({ mode: 'full', files: mockPrFiles, reason: 'comparison unavailable' });
  });

  it('a partial (failed / budget) review is never the incremental base', async () => {
    const complete = buildMarker({ headSha: 'old-complete', configHash: 'conf-1' });
    const partial = buildMarker({ headSha: 'newer-partial', configHash: 'conf-1', status: 'partial' });
    const compareCommits = vi.fn(async () => ({ status: 'ahead' as const, files: [], totalCommits: 2 }));
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [
          { id: 1, user: { login: publisherLogin }, body: complete },
          { id: 2, user: { login: publisherLogin }, body: partial },
        ];
      },
      compareCommits,
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-sha',
      publisherLogin, prFiles: mockPrFiles, configHash: 'conf-1',
    });

    expect(compareCommits).toHaveBeenCalledWith(expect.objectContaining({ base: 'old-complete', head: 'head-sha' }));
    expect(result).toMatchObject({ mode: 'incremental', sinceSha: 'old-complete', commitCount: 2 });
  });

  it('ignores markers from other accounts', async () => {
    const marker = buildMarker({ headSha: 'pasted', configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: 'mallory' }, body: marker }];
      },
      compareCommits: vi.fn(),
    };
    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-sha',
      publisherLogin, prFiles: mockPrFiles, configHash: 'conf-1',
    });
    expect(result.mode).toBe('full');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, GitHubPullRequestFile, GitHubReview } from './client.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { findLastReviewedHead, selectIncrementalFiles } from './incremental.js';

describe('findLastReviewedHead', () => {
  const publisherLogin = 'github-actions[bot]';

  it('returns null when there are no reviews on the PR', async () => {
    const client: Partial<GitHubClient> = {
      async listReviewsPage() { return []; },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 1, publisherLogin,
    });
    expect(result).toBeNull();
  });

  it('returns null when reviews exist but none have markers', async () => {
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [
          { id: 1, user: { login: publisherLogin }, body: 'LGTM without marker' },
          { id: 2, user: { login: publisherLogin }, body: null },
        ];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 1, publisherLogin,
    });
    expect(result).toBeNull();
  });

  it('ignores markers from other authors', async () => {
    const foreignMarker = buildMarker({ headSha: 'sha-foreign', configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [
          { id: 1, user: { login: 'contributor' }, body: `Review comment\n${foreignMarker}` },
          { id: 2, user: { login: 'someone-else' }, body: foreignMarker },
          { id: 3, user: null, body: foreignMarker },
        ];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 1, publisherLogin,
    });
    expect(result).toBeNull();
  });

  it('returns the head SHA from the marker of our review', async () => {
    const ourMarker = buildMarker({ headSha: 'sha-valid-123', configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: `Review summary\n\n${ourMarker}` }];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 1, publisherLogin,
    });
    expect(result).toBe('sha-valid-123');
  });

  it('picks the most recent of several of our reviews', async () => {
    const marker1 = buildMarker({ headSha: 'sha-old-1', configHash: 'conf-1' });
    const marker2 = buildMarker({ headSha: 'sha-new-2', configHash: 'conf-2' });
    const foreignMarker = buildMarker({ headSha: 'sha-foreign-3', configHash: 'conf-3' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [
          { id: 10, user: { login: publisherLogin }, body: `First review\n${marker1}` },
          { id: 11, user: { login: 'other-user' }, body: `Other review\n${foreignMarker}` },
          { id: 12, user: { login: publisherLogin }, body: `Second review\n${marker2}` },
        ];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 1, publisherLogin,
    });
    expect(result).toBe('sha-new-2');
  });

  it('paginates across multiple pages to find the most recent review on a later page', async () => {
    const markerPage1 = buildMarker({ headSha: 'sha-page-1', configHash: 'conf-1' });
    const markerPage2 = buildMarker({ headSha: 'sha-page-2', configHash: 'conf-2' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage({ page }) {
        if (page === 1) {
          const reviews: GitHubReview[] = Array.from({ length: 99 }, (_, i) => ({
            id: i + 1, user: { login: 'random-user' }, body: 'Random comment',
          }));
          reviews.push({ id: 100, user: { login: publisherLogin }, body: markerPage1 });
          return reviews;
        }
        if (page === 2) {
          return [{ id: 201, user: { login: publisherLogin }, body: `Latest review\n${markerPage2}` }];
        }
        return [];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 1, publisherLogin,
    });
    expect(result).toBe('sha-page-2');
  });
});

describe('selectIncrementalFiles', () => {
  const publisherLogin = 'github-actions[bot]';

  const mockPrFiles: PullRequestFile[] = [
    {
      path: 'src/main.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new',
      additions: 1,
      deletions: 1,
      changes: 2,
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
});

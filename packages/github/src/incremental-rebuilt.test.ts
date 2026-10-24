import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { selectIncrementalFiles } from './incremental.js';

/**
 * Incremental reviews keep the patches rebuilt for the whole PR (ADR-0045), and markers of other
 * accounts. A compared file without a patch is never shown as new changes: the whole pull request
 * is reviewed instead.
 */
describe('selectIncrementalFiles with rebuilt patches (ADR-0045)', () => {
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

  it('reviews the whole pull request when the comparison has no patch for a file', async () => {
    const lastSha = 'last-sha-no-patch';
    const headSha = 'head-sha-no-patch';
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
              additions: 1,
              deletions: 1,
              changes: 2,
              // The comparison's diff was too big for it: no patch at all.
            },
          ],
        };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles: mockPrFiles,
    });

    // The pull request's own patch holds the changes from before the last reviewed commit too:
    // they are not shown as new ones, so the whole pull request is reviewed.
    expect(result).toEqual({
      mode: 'full',
      files: mockPrFiles,
      reason: 'the new changes of src/main.ts are too large for the compare API',
    });
  });

  it('stays incremental for a changed binary file, which has no patch and no line changes', async () => {
    const marker = buildMarker({ headSha: 'last-sha-binary', configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return {
          status: 'ahead',
          files: [{ filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0 }],
        };
      },
    };
    const prFiles: PullRequestFile[] = [
      { path: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0 },
    ];

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-sha-binary',
      publisherLogin, prFiles,
    });

    expect(result.mode).toBe('incremental');
  });

  it('never takes the compare patch of a snapshot whose rebuilt diff was dropped', async () => {
    const marker = buildMarker({ headSha: 'last-sha-dropped', configHash: 'conf-1' });
    const snapshotPath = 'packages/db/migrations/meta/0176_snapshot.json';
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return {
          status: 'ahead',
          files: [{ filename: snapshotPath, status: 'added', additions: 3, deletions: 0, changes: 3, patch: '@@ -0,0 +1,3 @@\n+{\n+  "a": 1\n+}' }],
        };
      },
    };
    const prFiles: PullRequestFile[] = [
      { path: snapshotPath, status: 'added', additions: 3, deletions: 0, changes: 3 },
    ];

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha: 'head-sha-dropped',
      publisherLogin, prFiles,
    });

    expect(result.mode).toBe('incremental');
    expect(result.files[0]!.patch).toBeUndefined();
  });

  it('uses the rebuilt patch of an added snapshot, not the whole new file', async () => {
    const lastSha = 'last-sha-snapshot';
    const headSha = 'head-sha-snapshot';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });
    const snapshotPath = 'packages/db/migrations/meta/0176_snapshot.json';
    const rebuiltPatch = '@@ -0,0 +3,7 @@ compared with 0175_snapshot.json: only the regions that differ are shown';
    const prFiles: PullRequestFile[] = [
      { path: snapshotPath, status: 'added', patch: rebuiltPatch, additions: 7, deletions: 0, changes: 7 },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return {
          status: 'ahead',
          files: [
            {
              filename: snapshotPath,
              status: 'added',
              additions: 7,
              deletions: 0,
              changes: 7,
              // The comparison's patch is the whole new file.
              patch: '@@ -0,0 +1,9 @@\n+{\n+  "version": "7",',
            },
          ],
        };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles,
    });

    expect(result).toEqual({
      mode: 'incremental',
      files: [
        {
          path: snapshotPath,
          status: 'added',
          patch: rebuiltPatch,
          additions: 7,
          deletions: 0,
          changes: 7,
        },
      ],
      sinceSha: lastSha,
    });
  });

  it('keeps an unchanged snapshot with no changes, not the whole new file of the comparison', async () => {
    const lastSha = 'last-sha-unchanged-snapshot';
    const headSha = 'head-sha-unchanged-snapshot';
    const marker = buildMarker({ headSha: lastSha, configHash: 'conf-1' });
    const snapshotPath = 'packages/db/migrations/meta/0176_snapshot.json';
    // The rebuild compared the snapshot with the previous one and nothing differs: the file is
    // left with no patch and no changes at all.
    const prFiles: PullRequestFile[] = [
      { path: snapshotPath, status: 'added', additions: 0, deletions: 0, changes: 0 },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
      async compareCommits() {
        return {
          status: 'ahead',
          files: [
            {
              filename: snapshotPath,
              status: 'added',
              // The comparison counts the whole new file.
              additions: 20400,
              deletions: 0,
              changes: 20400,
              patch: '@@ -0,0 +1,20400 @@\n+{',
            },
          ],
        };
      },
    };

    const result = await selectIncrementalFiles(client as GitHubClient, {
      owner: 'acme', repo: 'repo', pull_number: 10, headSha,
      publisherLogin, prFiles,
    });

    // The counters are the rebuilt ones: the snapshot reaches the engine with no changes and no
    // patch, so it is skipped instead of being reported as a truncated patch.
    expect(result).toEqual({
      mode: 'incremental',
      files: [
        {
          path: snapshotPath,
          status: 'added',
          additions: 0,
          deletions: 0,
          changes: 0,
        },
      ],
      sinceSha: lastSha,
    });
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

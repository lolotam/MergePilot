import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { selectIncrementalFiles } from './incremental.js';

/** Incremental reviews keep the patches rebuilt for the whole PR (ADR-0045), and markers of other accounts. */
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

  it('uses the pull request patch when the comparison has none', async () => {
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

    // The whole patch of the file is reviewed instead of nothing.
    expect(result).toEqual({
      mode: 'incremental',
      files: [
        {
          path: 'src/main.ts',
          status: 'modified',
          patch: mockPrFiles[0]!.patch,
          additions: 1,
          deletions: 1,
          changes: 2,
        },
      ],
      sinceSha: lastSha,
    });
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

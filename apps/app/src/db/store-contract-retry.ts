import { expect, it } from 'vitest';
import type { AppStore, NewReviewRun } from '../core/types.js';

const WS = 'ws-runs-test';
const WS_OTHER = 'ws-alpha';

function makeRun(overrides: Partial<NewReviewRun> = {}): NewReviewRun {
  return {
    workspaceId: WS,
    installationId: 42,
    repoFullName: 'org/retry-test-repo',
    pullNumber: 1,
    headSha: 'sha-head-1',
    status: 'running',
    costUsd: null,
    detail: null,
    ...overrides,
  };
}

export function defineRetryContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  it('findActiveReviewRun returns queued or running run matching repo, PR, and headSha', async () => {
    const store = await createStore();
    try {
      // No run initially
      const none = await store.findActiveReviewRun(WS, 'org/active-repo', 10, 'sha-active-1');
      expect(none).toBeNull();

      // Create running run
      const running = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/active-repo',
          pullNumber: 10,
          headSha: 'sha-active-1',
          status: 'running',
        }),
      );

      const foundRunning = await store.findActiveReviewRun(WS, 'org/active-repo', 10, 'sha-active-1');
      expect(foundRunning).not.toBeNull();
      expect(foundRunning?.id).toBe(running.id);

      // Different headSha -> null
      expect(await store.findActiveReviewRun(WS, 'org/active-repo', 10, 'sha-diff')).toBeNull();

      // Different pullNumber -> null
      expect(await store.findActiveReviewRun(WS, 'org/active-repo', 11, 'sha-active-1')).toBeNull();

      // Different workspace -> null
      expect(await store.findActiveReviewRun(WS_OTHER, 'org/active-repo', 10, 'sha-active-1')).toBeNull();

      // Finish the run as completed -> now null
      await store.finishReviewRun(WS, running.id, {
        status: 'completed',
        costUsd: 0.01,
        detail: null,
      });
      expect(await store.findActiveReviewRun(WS, 'org/active-repo', 10, 'sha-active-1')).toBeNull();

      // Create a queued run -> found
      const queued = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/active-repo',
          pullNumber: 10,
          headSha: 'sha-active-2',
          status: 'queued',
        }),
      );
      const foundQueued = await store.findActiveReviewRun(WS, 'org/active-repo', 10, 'sha-active-2');
      expect(foundQueued).not.toBeNull();
      expect(foundQueued?.id).toBe(queued.id);
    } finally {
      await cleanup?.();
    }
  });

  it('listLatestFailedRuns picks only latest run per repo+PR whose latest status is failed', async () => {
    const store = await createStore();
    try {
      const now = Date.now();

      // PR 1: run1 failed, run2 completed -> latest is completed, NOT picked
      const pr1Run1 = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/latest-repo-a',
          pullNumber: 1,
          headSha: 'sha-1a',
          status: 'running',
        }),
      );
      await store.finishReviewRun(WS, pr1Run1.id, {
        status: 'failed',
        costUsd: null,
        detail: 'first failure',
      });

      await new Promise((r) => setTimeout(r, 10));
      const pr1Run2 = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/latest-repo-a',
          pullNumber: 1,
          headSha: 'sha-1b',
          status: 'running',
        }),
      );
      await store.finishReviewRun(WS, pr1Run2.id, {
        status: 'completed',
        costUsd: 0.05,
        detail: 'success',
      });

      // PR 2: run1 completed, run2 failed -> latest is failed, PICKED
      const pr2Run1 = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/latest-repo-a',
          pullNumber: 2,
          headSha: 'sha-2a',
          status: 'running',
        }),
      );
      await store.finishReviewRun(WS, pr2Run1.id, {
        status: 'completed',
        costUsd: 0.02,
        detail: 'first success',
      });

      await new Promise((r) => setTimeout(r, 10));
      const pr2Run2 = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/latest-repo-a',
          pullNumber: 2,
          headSha: 'sha-2b',
          status: 'running',
        }),
      );
      await store.finishReviewRun(WS, pr2Run2.id, {
        status: 'failed',
        costUsd: null,
        detail: 'recent failure',
      });

      // PR 3: only one run, which failed -> PICKED
      await new Promise((r) => setTimeout(r, 10));
      const pr3Run = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/latest-repo-b',
          pullNumber: 3,
          headSha: 'sha-3',
          status: 'running',
        }),
      );
      await store.finishReviewRun(WS, pr3Run.id, {
        status: 'failed',
        costUsd: null,
        detail: 'only failure',
      });

      // PR 4: run1 failed, run2 running -> latest is running, NOT picked
      await new Promise((r) => setTimeout(r, 10));
      const pr4Run1 = await store.createReviewRun(
        makeRun({
          repoFullName: 'org/latest-repo-b',
          pullNumber: 4,
          headSha: 'sha-4a',
          status: 'running',
        }),
      );
      await store.finishReviewRun(WS, pr4Run1.id, {
        status: 'failed',
        costUsd: null,
        detail: 'old failure',
      });

      await new Promise((r) => setTimeout(r, 10));
      await store.createReviewRun(
        makeRun({
          repoFullName: 'org/latest-repo-b',
          pullNumber: 4,
          headSha: 'sha-4b',
          status: 'running',
        }),
      );

      // Other workspace failure -> NOT picked
      const otherRun = await store.createReviewRun({
        workspaceId: WS_OTHER,
        installationId: 42,
        repoFullName: 'org/latest-repo-a',
        pullNumber: 5,
        headSha: 'sha-5',
        status: 'running',
        costUsd: null,
        detail: null,
      });
      await store.finishReviewRun(WS_OTHER, otherRun.id, {
        status: 'failed',
        costUsd: null,
        detail: 'other ws failure',
      });

      // Query latest failed runs for WS
      const failed = await store.listLatestFailedRuns(WS);
      expect(failed.map((r) => `${r.repoFullName}#${r.pullNumber}`)).toEqual([
        'org/latest-repo-b#3',
        'org/latest-repo-a#2',
      ]);
      expect(failed[0]?.id).toBe(pr3Run.id);
      expect(failed[1]?.id).toBe(pr2Run2.id);

      // Filtering by repo
      const repoFilter = await store.listLatestFailedRuns(WS, {
        repo: ['org/latest-repo-a'],
      });
      expect(repoFilter).toHaveLength(1);
      expect(repoFilter[0]?.id).toBe(pr2Run2.id);

      // Filtering by limit
      const limitFilter = await store.listLatestFailedRuns(WS, { limit: 1 });
      expect(limitFilter).toHaveLength(1);
      expect(limitFilter[0]?.id).toBe(pr3Run.id);

      // Filtering by date from in future -> empty
      const futureFilter = await store.listLatestFailedRuns(WS, {
        from: new Date(now + 100_000),
      });
      expect(futureFilter).toHaveLength(0);
    } finally {
      await cleanup?.();
    }
  });
}

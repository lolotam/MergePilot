import { expect, it } from 'vitest';
import { ActiveRunExistsError, type AppStore, type NewReviewRun } from '../core/types.js';

const WS = 'ws-runs-test';
const WS_OTHER = 'ws-alpha';

function run(overrides: Partial<NewReviewRun> = {}): NewReviewRun {
  return {
    workspaceId: WS,
    installationId: 42,
    repoFullName: 'org/active-unique',
    pullNumber: 3,
    headSha: 'sha-active',
    status: 'queued',
    costUsd: null,
    detail: null,
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

/** One queued/running run per head (migration 0004) and the latest-per-PR date window. */
export function defineActiveRunContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  it('rejects a second queued/running run for the same head with ActiveRunExistsError', async () => {
    const store = await createStore();
    try {
      const first = await store.createReviewRun(run({ status: 'queued' }));
      await expect(store.createReviewRun(run({ status: 'running' }))).rejects.toBeInstanceOf(
        ActiveRunExistsError,
      );
      await expect(store.createReviewRun(run({ jobId: 'job-other' }))).rejects.toBeInstanceOf(
        ActiveRunExistsError,
      );

      // Other heads, PRs and workspaces, and inactive statuses, are not affected.
      await store.createReviewRun(run({ headSha: 'sha-other' }));
      await store.createReviewRun(run({ pullNumber: 4 }));
      await store.createReviewRun(run({ workspaceId: WS_OTHER }));
      await store.createReviewRun(run({ status: 'skipped', detail: 'x' }));
      await store.createReviewRun(run({ status: 'failed', detail: 'x' }));

      // Once the active run finishes, the head is free again.
      await store.finishReviewRun(WS, first.id, { status: 'completed', costUsd: 0, detail: null });
      const next = await store.createReviewRun(run({ status: 'running' }));
      expect(next.status).toBe('running');
    } finally {
      await cleanup?.();
    }
  });

  it('job id reuse keeps working: a queued run moves to running on its own row', async () => {
    const store = await createStore();
    try {
      const queued = await store.createReviewRun(run({ jobId: 'job-reuse-active' }));
      const running = await store.createReviewRun(
        run({ jobId: 'job-reuse-active', status: 'running' }),
      );
      expect(running.id).toBe(queued.id);
      expect(running.status).toBe('running');
    } finally {
      await cleanup?.();
    }
  });

  it('reusing a failed run of a job is rejected while another run for that head is active', async () => {
    const store = await createStore();
    try {
      const failed = await store.createReviewRun(run({ jobId: 'job-failed', status: 'running' }));
      await store.finishReviewRun(WS, failed.id, { status: 'failed', costUsd: null, detail: 'x' });
      const active = await store.createReviewRun(run({ jobId: 'job-active' }));

      await expect(
        store.createReviewRun(run({ jobId: 'job-failed', status: 'running' })),
      ).rejects.toBeInstanceOf(ActiveRunExistsError);
      expect((await store.getReviewRun(WS, failed.id))?.status).toBe('failed');
      expect((await store.getReviewRun(WS, active.id))?.status).toBe('queued');
    } finally {
      await cleanup?.();
    }
  });

  it('listLatestFailedRuns applies the date window to the latest run of each PR', async () => {
    const store = await createStore();
    try {
      const repoFullName = 'org/window-repo';
      // PR 1 failed inside the window, then completed after it: NOT picked.
      const failedEarly = await store.createReviewRun(
        run({ repoFullName, pullNumber: 1, headSha: 'w1a', status: 'running' }),
      );
      await store.finishReviewRun(WS, failedEarly.id, { status: 'failed', costUsd: null, detail: 'x' });
      // PR 2 failed inside the window and nothing since: picked.
      const failedOnly = await store.createReviewRun(
        run({ repoFullName, pullNumber: 2, headSha: 'w2', status: 'running' }),
      );
      await store.finishReviewRun(WS, failedOnly.id, { status: 'failed', costUsd: null, detail: 'x' });
      await tick();
      const windowEnd = new Date();
      await tick();
      const completedLater = await store.createReviewRun(
        run({ repoFullName, pullNumber: 1, headSha: 'w1b', status: 'running' }),
      );
      await store.finishReviewRun(WS, completedLater.id, { status: 'completed', costUsd: 0, detail: null });

      const inWindow = await store.listLatestFailedRuns(WS, { repo: [repoFullName], to: windowEnd });
      expect(inWindow.map((r) => r.id)).toEqual([failedOnly.id]);

      // A window that starts after PR 2's failure excludes it too.
      const afterWindow = await store.listLatestFailedRuns(WS, {
        repo: [repoFullName],
        from: windowEnd,
      });
      expect(afterWindow).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });
}

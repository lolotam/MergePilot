import { expect, it } from 'vitest';
import type { AppStore, NewReviewRun, ReviewRunStatus } from '../core/types.js';

const WS = 'ws-runs-test';
const MINUTE = 60 * 1000;

function newRun(overrides: Partial<NewReviewRun> = {}): NewReviewRun {
  return {
    workspaceId: WS,
    installationId: 42,
    repoFullName: 'org/lifecycle-repo',
    pullNumber: 7,
    headSha: 'sha-first',
    status: 'running',
    costUsd: null,
    detail: null,
    ...overrides,
  };
}

/** Job-id reuse, heartbeat and stale-run sweep part of the AppStore contract. */
export function defineReviewRunLifecycleContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  for (const status of ['running', 'failed'] as const) {
    it(`reuses a ${status} run when the same jobId is retried`, async () => {
      const store = await createStore();
      try {
        const jobId = `job-reuse-${status}`;
        const first = await store.createReviewRun(newRun({ jobId }));
        if (status === 'failed') {
          await store.finishReviewRun(WS, first.id, { status, costUsd: null, detail: 'boom' });
        }

        const retry = await store.createReviewRun(newRun({ jobId, headSha: 'sha-second' }));
        expect(retry.id).toBe(first.id);
        expect(retry.status).toBe('running');
        expect(retry.headSha).toBe('sha-second');
        expect(retry.finishedAt).toBeNull();
        expect(retry.detail).toBeNull();

        const list = await store.listReviewRuns(WS, 50);
        expect(list.filter((r) => r.jobId === jobId)).toHaveLength(1);
      } finally {
        await cleanup?.();
      }
    });
  }

  it('keeps one run per bot when a job runs several bots, and a retry reuses only its own bot', async () => {
    const store = await createStore();
    try {
      const jobId = 'job-panel';
      const main = await store.createReviewRun(newRun({ jobId }));
      const second = await store.createReviewRun(newRun({ jobId, botSlot: 2, botName: 'Owl' }));
      expect(second.id).not.toBe(main.id);
      expect([main.botSlot, second.botSlot]).toEqual([1, 2]);

      await store.finishReviewRun(WS, second.id, { status: 'failed', costUsd: null, detail: 'boom' });
      const retry = await store.createReviewRun(newRun({ jobId, botSlot: 2, botName: 'Owl' }));
      expect(retry.id).toBe(second.id);
      const runs = (await store.listReviewRuns(WS, 50)).filter((r) => r.jobId === jobId);
      expect(runs.map((r) => r.botSlot).sort()).toEqual([1, 2]);
      expect(runs.find((r) => r.botSlot === 1)?.id).toBe(main.id);
    } finally {
      await cleanup?.();
    }
  });

  for (const status of ['completed', 'skipped'] as const satisfies readonly ReviewRunStatus[]) {
    it(`never overwrites a ${status} run with the same jobId; creates a new run`, async () => {
      const store = await createStore();
      try {
        const jobId = `job-final-${status}`;
        const first = await store.createReviewRun(newRun({ jobId }));
        await store.finishReviewRun(WS, first.id, {
          status,
          costUsd: 0.5,
          detail: 'final',
          findingsCount: 3,
        });

        const second = await store.createReviewRun(newRun({ jobId, headSha: 'sha-second' }));
        expect(second.id).not.toBe(first.id);
        expect(second.status).toBe('running');

        const kept = await store.getReviewRun(WS, first.id);
        expect(kept?.status).toBe(status);
        expect(kept?.headSha).toBe('sha-first');
        expect(kept?.costUsd).toBe(0.5);
        expect(kept?.detail).toBe('final');
        expect(kept?.findingsCount).toBe(3);
        expect(kept?.finishedAt).toBeInstanceOf(Date);

        // A retry of the new run reuses it, not the finished one.
        const third = await store.createReviewRun(newRun({ jobId }));
        expect(third.id).toBe(second.id);
      } finally {
        await cleanup?.();
      }
    });
  }

  it('sets the heartbeat on create, touch and finish; touch ignores finished runs', async () => {
    const store = await createStore();
    try {
      const before = Date.now();
      const run = await store.createReviewRun(newRun({ repoFullName: 'org/heartbeat' }));
      expect(run.updatedAt).toBeInstanceOf(Date);
      expect(run.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.touchReviewRun(WS, run.id);
      const touched = await store.getReviewRun(WS, run.id);
      expect(touched?.updatedAt.getTime()).toBeGreaterThan(run.updatedAt.getTime());

      // Another workspace cannot touch it.
      await store.touchReviewRun('ws-alpha', run.id);

      await store.finishReviewRun(WS, run.id, { status: 'completed', costUsd: null, detail: null });
      const finished = await store.getReviewRun(WS, run.id);
      expect(finished?.updatedAt.getTime()).toBeGreaterThanOrEqual(touched?.updatedAt.getTime() ?? 0);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.touchReviewRun(WS, run.id);
      const after = await store.getReviewRun(WS, run.id);
      expect(after?.status).toBe('completed');
      expect(after?.updatedAt.getTime()).toBe(finished?.updatedAt.getTime());
    } finally {
      await cleanup?.();
    }
  });

  it('fails only queued/running runs whose heartbeat is older than the cutoff', async () => {
    const store = await createStore();
    try {
      const live = await store.createReviewRun(newRun({ repoFullName: 'org/live' }));
      const queued = await store.createReviewRun(newRun({ repoFullName: 'org/q', status: 'queued' }));
      const done = await store.createReviewRun(newRun({ repoFullName: 'org/done' }));
      await store.finishReviewRun(WS, done.id, { status: 'completed', costUsd: null, detail: null });

      // A fresh heartbeat is not stale for a 15-minute cutoff.
      expect(await store.failStaleRuns(new Date(Date.now() - 15 * MINUTE))).toBe(0);
      expect((await store.getReviewRun(WS, live.id))?.status).toBe('running');

      // A cutoff in the future makes every in-progress run stale; finished runs are untouched.
      const reported: Array<{ workspaceId: string; id: string }> = [];
      const failed = await store.failStaleRuns(new Date(Date.now() + MINUTE), (refs) => reported.push(...refs));
      expect(failed).toBeGreaterThanOrEqual(2);
      // The callback names exactly the failed runs (ADR-0021 live updates).
      expect(reported).toHaveLength(failed);
      expect(reported).toEqual(expect.arrayContaining([{ workspaceId: WS, id: live.id }, { workspaceId: WS, id: queued.id }]));
      expect(reported.map((r) => r.id)).not.toContain(done.id);
      for (const id of [live.id, queued.id]) {
        const r = await store.getReviewRun(WS, id);
        expect(r?.status).toBe('failed');
        expect(r?.detail).toBe('interrupted');
        expect(r?.finishedAt).toBeInstanceOf(Date);
      }
      expect((await store.getReviewRun(WS, done.id))?.status).toBe('completed');

      const repos = await store.listReviewRunRepos(WS);
      expect(repos).toEqual(expect.arrayContaining(['org/done', 'org/live', 'org/q']));
    } finally {
      await cleanup?.();
    }
  });
}

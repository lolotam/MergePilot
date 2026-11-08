import { describe, expect, it } from 'vitest';
import { toRunDto } from '../api/run-dto.js';
import { MemoryStore } from './memory-store.js';
import { createTestDb } from '../db/test-db.js';

for (const kind of ['memory', 'postgres'] as const) {
  describe(`${kind} review progress`, { timeout: 30000 }, () => {
    it('accepts a live attempt after a stale sweep but rejects terminal and duplicate writes', async () => {
      const pg = kind === 'postgres' ? await createTestDb(undefined, { workspaces: ['ws'] }) : null;
      const store = pg?.store ?? new MemoryStore();
      try {
        const run = await store.createReviewRun({ workspaceId: 'ws', jobId: 'job', installationId: 1, repoFullName: 'a/b', pullNumber: 1, headSha: 'sha', status: 'running', costUsd: null, detail: null });
        await store.failStaleRuns(new Date(Date.now() + 10000));
        expect((await store.getReviewRun('ws', run.id))?.detail).toBe('interrupted');
        const progress = { status: 'completed' as const, finishedAt: new Date().toISOString() };
        await store.recordReviewProgress('ws', run.id, run.attemptId!, progress);
        expect((await store.getReviewRun('ws', run.id))?.reviewProgress).toEqual(progress);
        await store.recordReviewProgress('ws', run.id, run.attemptId!, { ...progress, status: 'failed' });
        expect((await store.getReviewRun('ws', run.id))?.reviewProgress).toEqual(progress);
        const retry = await store.createReviewRun({ workspaceId: 'ws', jobId: 'retry', installationId: 1, repoFullName: 'a/b', pullNumber: 1, headSha: 'sha', status: 'running', costUsd: null, detail: null });
        await store.finishReviewRun('ws', retry.id, { status: 'failed', costUsd: null, detail: 'publisher failed' });
        await store.recordReviewProgress('ws', retry.id, retry.attemptId!, progress);
        expect((await store.getReviewRun('ws', retry.id))?.reviewProgress).toBeNull();
      } finally { await pg?.close(); }
    });
    it('preserves active uniqueness and usage, resets retries and rejects stale/cross-workspace writes', async () => {
      const pg = kind === 'postgres' ? await createTestDb(undefined, { workspaces: ['ws', 'other'] }) : null;
      const store = pg?.store ?? new MemoryStore();
      try {
        const input = { workspaceId: 'ws', jobId: 'job', installationId: 1, repoFullName: 'a/b', pullNumber: 1, headSha: 'sha', status: 'running' as const, costUsd: null, detail: null };
        const first = await store.createReviewRun(input);
        const progress = { status: 'completed' as const, finishedAt: new Date().toISOString() };
        await store.recordReviewProgress('other', first.id, first.attemptId!, progress);
        expect((await store.getReviewRun('ws', first.id))?.reviewProgress).toBeNull();
        await store.recordReviewProgress('ws', first.id, first.attemptId!, progress);
        const reviewed = await store.getReviewRun('ws', first.id);
        expect(reviewed?.reviewProgress).toEqual(progress);
        expect(reviewed?.status).toBe('running');
        expect(reviewed?.finishedAt).toBeNull();
        expect(reviewed?.result).toBeNull();
        const dto = toRunDto(reviewed!);
        expect(dto.reviewProgress).toEqual(progress);
        expect(dto.status).toBe('running');
        expect(dto.findingsCount).toBeNull();
        expect(dto.inputTokens).toBeNull();
        expect(await store.listMonthlyUsage('ws')).toEqual([]);
        expect((await store.findActiveReviewRun('ws', 'a/b', 1, 'sha'))?.id).toBe(first.id);
        await expect(store.createReviewRun({ ...input, jobId: 'another' })).rejects.toThrow();
        await store.finishReviewRun('ws', first.id, { status: 'failed', costUsd: null, detail: 'publisher failed' });
        expect((await store.getReviewRun('ws', first.id))?.reviewProgress).toEqual(progress);
        const latestFailed = (await store.listLatestFailedRuns('ws'))[0];
        expect(latestFailed?.reviewProgress).toEqual(progress);
        expect(latestFailed?.attemptId).toBe(first.attemptId);
        expect(latestFailed?.reviewStartedAt).toEqual(first.reviewStartedAt);
        const retry = await store.createReviewRun(input);
        expect(retry.id).toBe(first.id);
        expect(retry.attemptId).not.toBe(first.attemptId);
        expect(retry.reviewProgress).toBeNull();
        await store.recordReviewProgress('ws', first.id, first.attemptId!, progress);
        expect((await store.getReviewRun('ws', first.id))?.reviewProgress).toBeNull();
        await store.recordReviewProgress('ws', retry.id, retry.attemptId!, { ...progress, status: 'skipped' });
        expect((await store.getReviewRun('ws', retry.id))?.reviewProgress?.status).toBe('skipped');
      } finally { await pg?.close(); }
    });
  });
}

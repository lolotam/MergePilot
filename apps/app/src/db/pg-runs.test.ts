import { describe, expect, it } from 'vitest';
import { createTestDb } from './test-db.js';

const WS = 'ws-heartbeat';
const MINUTE = 60 * 1000;

describe('PgStore stale-run sweep uses the heartbeat, not created_at', { timeout: 20000 }, () => {
  it('keeps an old run with a fresh heartbeat and fails one whose heartbeat is stale', async () => {
    const { store, client, close } = await createTestDb(undefined, { workspaces: [WS] });
    try {
      const base = {
        workspaceId: WS,
        installationId: 1,
        pullNumber: 1,
        headSha: 'sha',
        status: 'running' as const,
        costUsd: null,
        detail: null,
      };
      const longButAlive = await store.createReviewRun({ ...base, repoFullName: 'org/long' });
      const dead = await store.createReviewRun({ ...base, repoFullName: 'org/dead' });

      // Both started an hour ago; only `dead` stopped sending heartbeats 20 minutes ago.
      await client.query(
        `UPDATE review_runs SET created_at = now() - interval '60 minutes' WHERE id IN ($1, $2);`,
        [longButAlive.id, dead.id],
      );
      await client.query(
        `UPDATE review_runs SET updated_at = now() - interval '20 minutes' WHERE id = $1;`,
        [dead.id],
      );

      const failed = await store.failStaleRuns(new Date(Date.now() - 15 * MINUTE));
      expect(failed).toBe(1);
      expect((await store.getReviewRun(WS, longButAlive.id))?.status).toBe('running');
      const deadRun = await store.getReviewRun(WS, dead.id);
      expect(deadRun?.status).toBe('failed');
      expect(deadRun?.detail).toBe('interrupted');
    } finally {
      await close();
    }
  });

  it('allows a new run for a job whose earlier run completed (partial unique index)', async () => {
    const { store, close } = await createTestDb(undefined, { workspaces: [WS] });
    try {
      const base = {
        workspaceId: WS,
        jobId: 'job-1',
        installationId: 1,
        repoFullName: 'org/repo',
        pullNumber: 1,
        headSha: 'sha',
        status: 'running' as const,
        costUsd: null,
        detail: null,
      };
      const first = await store.createReviewRun(base);
      await store.finishReviewRun(WS, first.id, { status: 'completed', costUsd: null, detail: null });
      const second = await store.createReviewRun(base);
      await store.finishReviewRun(WS, second.id, { status: 'completed', costUsd: null, detail: null });
      const third = await store.createReviewRun(base);
      expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    } finally {
      await close();
    }
  });
});

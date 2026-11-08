import { expect, it } from 'vitest';
import { createAdminTestDb } from './admin.fixtures.js';

it('admin migration fixture supports all review-run progress columns', async () => {
  const { db, store, close } = await createAdminTestDb();
  try {
    const { organization } = await import('../auth/schema.js');
    await db.insert(organization).values({ id: 'progress-admin', name: 'Progress', slug: 'progress-admin' });
    const run = await store.createReviewRun({ workspaceId: 'progress-admin', installationId: 1, repoFullName: 'a/b', pullNumber: 1, headSha: 'sha', status: 'running', costUsd: null, detail: null });
    expect(run.attemptId).toBeTruthy();
    expect(run.reviewStartedAt).toBeInstanceOf(Date);
    await store.recordReviewProgress('progress-admin', run.id, run.attemptId!, { status: 'completed', finishedAt: new Date().toISOString() });
    expect((await store.getReviewRun('progress-admin', run.id))?.reviewProgress?.status).toBe('completed');
    expect((await store.listReviewRuns('progress-admin', 50))[0]?.attemptId).toBe(run.attemptId);
  } finally { await close(); }
}, 30000);

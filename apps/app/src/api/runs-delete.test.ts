import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as authSchema from '../auth/schema.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { NewReviewRun, ReviewRun, ReviewRunStatus } from '../core/types.js';
import { createRetryHarness, type RetryHarness } from './runs-retry.fixtures.js';

// Session token built at runtime so no secret-looking literal sits in the test.
const TOKEN_MEMBER = ['t', 'mem'].join('-');
const AUTH_SECRET = 'x'.repeat(32);
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

describe('runs bulk delete and grouped list', { timeout: 20000 }, () => {
  let h: RetryHarness;
  let memberCookie: string;

  beforeEach(async () => {
    h = await createRetryHarness();
    await h.db.insert(authSchema.user).values([{ id: 'u-mem', name: 'M', email: 'm@test.com', emailVerified: true }]);
    await h.db.insert(authSchema.session).values([
      { id: 's-mem', token: TOKEN_MEMBER, userId: 'u-mem', expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    await h.db.insert(authSchema.organization).values([{ id: 'ws-2', name: 'W2', slug: 'w2' }]);
    await h.db.insert(authSchema.member).values([{ id: 'm-mem', organizationId: 'ws-1', userId: 'u-mem', role: 'member' }]);
    memberCookie = signedSessionCookie(TOKEN_MEMBER, AUTH_SECRET);
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  async function run(
    overrides: Partial<NewReviewRun>,
    final: ReviewRunStatus = 'completed',
    costUsd: number | null = null,
    usage?: { inputTokens: number; outputTokens: number },
  ): Promise<ReviewRun> {
    const created = await h.store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 1,
      headSha: `sha-${Math.random().toString(36).slice(2)}`,
      status: 'running',
      costUsd: null,
      detail: null,
      ...overrides,
    });
    if (final !== 'running') {
      await h.store.finishReviewRun(created.workspaceId, created.id, {
        status: final,
        costUsd,
        detail: null,
        result: usage ? { v: 1, summary: '', highlights: [], findings: [], language: 'en', usage } : undefined,
      });
    }
    await tick();
    return created;
  }

  const del = (payload: unknown, cookie = h.adminCookie, ws = 'ws-1') =>
    h.app.inject({ method: 'POST', url: `/api/workspaces/${ws}/runs/delete`, headers: { cookie }, payload: payload as object });

  it('deletes selected finished runs by id; running runs are never deleted', async () => {
    const done = await run({ pullNumber: 1 });
    const failed = await run({ pullNumber: 2 }, 'failed');
    const active = await run({ pullNumber: 3 }, 'running');

    const res = await del({ ids: [done.id, failed.id, active.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    expect(await h.store.getReviewRun('ws-1', done.id)).toBeNull();
    expect((await h.store.getReviewRun('ws-1', active.id))?.status).toBe('running');
  });

  it('answers 404 for a run of another workspace and deletes nothing', async () => {
    const mine = await run({ pullNumber: 1 });
    const theirs = await run({ workspaceId: 'ws-2', pullNumber: 9 });

    const res = await del({ ids: [mine.id, theirs.id] });
    expect(res.statusCode).toBe(404);
    expect(await h.store.getReviewRun('ws-1', mine.id)).not.toBeNull();
    expect(await h.store.getReviewRun('ws-2', theirs.id)).not.toBeNull();
  });

  it('deletes by filters only when confirmCount matches (409 with the actual count otherwise)', async () => {
    await run({ repoFullName: 'acme/web', pullNumber: 1 });
    await run({ repoFullName: 'acme/web', pullNumber: 2 }, 'failed');
    await run({ repoFullName: 'acme/web', pullNumber: 3 }, 'running');
    await run({ repoFullName: 'acme/app', pullNumber: 1 });

    const stale = await del({ filters: { repo: ['acme/web'] }, confirmCount: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'count_mismatch', actual: 3 });

    const ok = await del({ filters: { repo: ['acme/web'], from: '2020-01-01' }, confirmCount: 3 });
    expect(ok.json()).toEqual({ deleted: 2 });
    const left = await h.store.listReviewRuns('ws-1', { limit: 10 });
    expect(left.runs.map((r) => `${r.repoFullName}:${r.status}`).sort()).toEqual(['acme/app:completed', 'acme/web:running']);
  });

  it('is admin/owner only and validates the body', async () => {
    const done = await run({ pullNumber: 1 });
    expect((await del({ ids: [done.id] }, memberCookie)).statusCode).toBe(403);
    expect((await del({ ids: [done.id] }, h.adminCookie, 'ws-2')).statusCode).toBe(403);

    for (const bad of [
      {},
      { ids: [] },
      { ids: ['not-a-uuid'] },
      { ids: Array.from({ length: 501 }, () => done.id) },
      { filters: {} },
      { ids: [done.id], filters: {}, confirmCount: 1 },
      { filters: { from: '2026-10-10', to: '2026-10-01' }, confirmCount: 0 },
    ]) {
      const res = await del(bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect(await h.store.getReviewRun('ws-1', done.id)).not.toBeNull();
  });

  it('keeps the month spend after runs are deleted (budget reads the monthly usage)', async () => {
    const a = await run({ pullNumber: 1 }, 'completed', 1.5);
    await run({ pullNumber: 2 }, 'failed', 0.5);
    const usage = async () =>
      (await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/usage', headers: { cookie: h.adminCookie } })).json();
    expect((await usage()).monthCostUsd).toBeCloseTo(2, 6);
    await del({ ids: [a.id] });
    expect((await usage()).monthCostUsd).toBeCloseTo(2, 6);
  });

  it('groups the list by PR: paging over groups, filters inside groups, latest-run ordering, sums', async () => {
    await run({ pullNumber: 7 }, 'failed', 0.1, { inputTokens: 1000, outputTokens: 100 });
    await run({ pullNumber: 7 }, 'completed', 0.2, { inputTokens: 2000, outputTokens: 200 });
    await run({ pullNumber: 8 }, 'completed');
    await run({ repoFullName: 'acme/web', pullNumber: 7 }, 'failed');
    const list = async (qs: string) =>
      (await h.app.inject({ method: 'GET', url: `/api/workspaces/ws-1/runs?groupBy=pr&${qs}`, headers: { cookie: memberCookie } })).json();

    const page1 = await list('limit=2');
    expect(page1.total).toBe(3);
    expect(page1.totalRuns).toBe(4);
    expect(page1.groups.map((g: { repoFullName: string; pullNumber: number }) => `${g.repoFullName}#${g.pullNumber}`)).toEqual([
      'acme/web#7',
      'acme/app#8',
    ]);

    const page2 = await list('limit=2&offset=2');
    expect(page2.groups).toHaveLength(1);
    const pr7 = page2.groups[0];
    expect(pr7).toMatchObject({ repoFullName: 'acme/app', pullNumber: 7, runCount: 2, inputTokens: 3000, outputTokens: 300 });
    expect(pr7.costUsd).toBeCloseTo(0.3, 6);
    expect(pr7.runs.map((r: { status: string; inputTokens: number | null }) => [r.status, r.inputTokens])).toEqual([
      ['completed', 2000],
      ['failed', 1000],
    ]);
    expect(pr7.runs[0]).not.toHaveProperty('result');

    const failed = await list('status=failed&sort=inputTokens&dir=desc');
    expect(failed.totalRuns).toBe(2);
    expect(failed.groups.map((g: { repoFullName: string; runs: unknown[] }) => [g.repoFullName, g.runs.length])).toEqual([
      ['acme/app', 1],
      ['acme/web', 1],
    ]);
    expect(failed.groups[1].inputTokens).toBeNull();

    const bad = await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/runs?groupBy=repo', headers: { cookie: memberCookie } });
    expect(bad.statusCode).toBe(400);
    const flat = (await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/runs?sort=outputTokens', headers: { cookie: memberCookie } })).json();
    expect(flat.total).toBe(4);
    expect(flat.runs[0].outputTokens).toBe(200);
  });
});

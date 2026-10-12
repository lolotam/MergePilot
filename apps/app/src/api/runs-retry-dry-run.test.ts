import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRetryRateLimits } from './runs-retry.js';
import { createRetryHarness, type RetryHarness } from './runs-retry.fixtures.js';

const RETRY_FAILED = '/api/workspaces/ws-1/runs/retry-failed';

describe('retry endpoints: dry run, validation, rate limit and active-run races', { timeout: 25000 }, () => {
  let h: RetryHarness;

  // One database for the file (booting PGlite per test is slow); each test uses its own repos.
  beforeAll(async () => {
    h = await createRetryHarness();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    resetRetryRateLimits();
    h.enqueued.length = 0;
    h.prs.clear();
  });

  const post = (payload: unknown) =>
    h.app.inject({ method: 'POST', url: RETRY_FAILED, headers: { cookie: h.adminCookie }, payload: payload as object });

  it('dryRun previews exactly what the real call then queues, without queueing or rate limiting', async () => {
    const repoFullName = 'acme/dry';
    await h.seedRun({ repoFullName, pullNumber: 1 });
    await h.seedRun({ repoFullName, pullNumber: 2 });
    await h.seedRun({ repoFullName, pullNumber: 3 });
    h.prs.set('acme/dry#3', { state: 'closed', head: { sha: 'sha-3' } });
    await h.seedRun({ repoFullName: 'acme/dry-other', pullNumber: 9 });
    const filters = { repo: [repoFullName], from: '2000-01-01', to: '2999-12-31' };

    const dry1 = await post({ ...filters, dryRun: true });
    const dry2 = await post({ ...filters, dryRun: true });
    expect(dry1.statusCode).toBe(200);
    expect(dry2.statusCode).toBe(200);
    const preview = dry1.json();
    expect(preview.wouldQueue).toBe(2);
    expect(preview.items).toEqual(
      expect.arrayContaining([
        { repo: 'acme/dry', pullNumber: 1 },
        { repo: 'acme/dry', pullNumber: 2 },
      ]),
    );
    expect(preview.skipped).toEqual([{ repo: 'acme/dry', pullNumber: 3, reason: 'pr_closed' }]);
    expect(h.enqueued).toHaveLength(0);

    const real = await post(filters);
    expect(real.statusCode).toBe(200);
    expect(real.json().queued).toBe(preview.wouldQueue);
    expect(h.enqueued.map((j) => j.pullNumber).sort()).toEqual([1, 2]);
  });

  it.each([
    ['a bad from date', { from: 'yesterday' }],
    ['a bad to date-time', { to: '2026-13-01T00:00:00Z' }],
    ['from after to', { from: '2026-10-12', to: '2026-10-01' }],
    ['more than 50 repos', { repo: Array.from({ length: 51 }, (_, i) => `acme/r${i}`) }],
    ['a non-array repo', { repo: 'acme/app' }],
    ['a non-boolean dryRun', { dryRun: 'yes' }],
  ])('rejects %s with 400 and does not consume the rate limit', async (_label, body) => {
    const bad = await post(body);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_error');

    const ok = await post({ repo: ['acme/nothing-here'] });
    expect(ok.statusCode).toBe(200);
  });

  it('accepts ISO date-times with an offset', async () => {
    const res = await post({
      repo: ['acme/nothing-here'],
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-12T23:59:59+03:00',
    });
    expect(res.statusCode).toBe(200);
  });

  it('records the rate limit only for a real call', async () => {
    const none = { repo: ['acme/nothing-here'] };
    expect((await post({ ...none, dryRun: true })).statusCode).toBe(200);
    expect((await post(none)).statusCode).toBe(200);
    expect((await post(none)).statusCode).toBe(429);
    // A dry run is still allowed while the real call is limited.
    expect((await post({ ...none, dryRun: true })).statusCode).toBe(200);
  });

  it('single retry maps a lost race (unique index) to 409 already_running', async () => {
    const failed = await h.seedRun({ repoFullName: 'acme/race-single', pullNumber: 5 });
    h.prs.set('acme/race-single#5', { state: 'open', head: { sha: 'sha-race' } });
    await h.store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/race-single',
      pullNumber: 5,
      headSha: 'sha-race',
      status: 'queued',
      costUsd: null,
      detail: null,
    });
    // The pre-check misses the active run (as in a race); the insert must still be refused.
    vi.spyOn(h.store, 'findActiveReviewRun').mockResolvedValue(null);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-1/runs/${failed.id}/retry`,
      headers: { cookie: h.adminCookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_running');
    expect(h.enqueued).toHaveLength(0);
  });

  it('retry-failed reports a lost race as a skipped already_running item', async () => {
    await h.seedRun({ repoFullName: 'acme/race-all', pullNumber: 6 });
    h.prs.set('acme/race-all#6', { state: 'open', head: { sha: 'sha-race-6' } });
    const realCreate = h.store.createReviewRun.bind(h.store);
    // Another request wins the race between the pre-check and the insert.
    vi.spyOn(h.store, 'createReviewRun').mockImplementationOnce(async (run) => {
      await realCreate({ ...run, jobId: 'racing-job' });
      return realCreate(run);
    });

    const res = await post({ repo: ['acme/race-all'] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      queued: 0,
      skipped: [{ repo: 'acme/race-all', pullNumber: 6, reason: 'already_running' }],
    });
    expect(h.enqueued).toHaveLength(0);
  });
});

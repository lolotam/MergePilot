import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewRunStatus } from '../core/types.js';
import { reviewRuns } from '../db/schema.js';
import { createRetryHarness, type RetryHarness } from './runs-retry.fixtures.js';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const SEC = 1000;

describe('runs list duration (durationMs + sort=duration)', { timeout: 30000 }, () => {
  let h: RetryHarness;

  beforeEach(async () => {
    h = await createRetryHarness();
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  /**
   * A run of acme/app#pullNumber created at T0 + `startOffsetSec`; finished runs end `tookSec`
   * later (null keeps finished_at empty).
   */
  async function run(pullNumber: number, status: ReviewRunStatus, startOffsetSec: number, tookSec: number | null) {
    const created = await h.store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber,
      headSha: `sha-${pullNumber}-${startOffsetSec}`,
      status: 'running',
      costUsd: null,
      detail: null,
    });
    if (status !== 'running') {
      await h.store.finishReviewRun('ws-1', created.id, { status, costUsd: null, detail: null });
    }
    const createdAt = new Date(T0 + startOffsetSec * SEC);
    await h.db
      .update(reviewRuns)
      .set({ createdAt, finishedAt: tookSec === null ? null : new Date(createdAt.getTime() + tookSec * SEC) })
      .where(eq(reviewRuns.id, created.id));
    return created.id;
  }

  const get = async (qs: string) =>
    (await h.app.inject({ method: 'GET', url: `/api/workspaces/ws-1/runs?${qs}`, headers: { cookie: h.adminCookie } })).json();

  it('returns durationMs in the flat list and the run detail; null while running or when unknown', async () => {
    const done = await run(1, 'completed', 0, 75);
    const active = await run(2, 'running', 10, null);
    const noEnd = await run(3, 'failed', 20, null);

    const flat = await get('sort=createdAt&dir=asc');
    const byId = new Map(flat.runs.map((r: { id: string; durationMs: number | null }) => [r.id, r.durationMs]));
    expect(byId.get(done)).toBe(75_000);
    expect(byId.get(active)).toBeNull();
    expect(byId.get(noEnd)).toBeNull();

    const detail = (
      await h.app.inject({ method: 'GET', url: `/api/workspaces/ws-1/runs/${done}`, headers: { cookie: h.adminCookie } })
    ).json();
    expect(detail.run.durationMs).toBe(75_000);
  });

  it('sorts the flat list by duration with NULLs last in both directions', async () => {
    const short = await run(1, 'completed', 0, 5);
    const long = await run(2, 'failed', 10, 300);
    const active = await run(3, 'running', 20, null);
    const mid = await run(4, 'skipped', 30, 60);

    const ids = (body: { runs: Array<{ id: string }> }) => body.runs.map((r) => r.id);
    expect(ids(await get('sort=duration&dir=desc'))).toEqual([long, mid, short, active]);
    expect(ids(await get('sort=duration&dir=asc'))).toEqual([short, mid, long, active]);
  });

  it('grouped mode: each run carries its duration and groups sort by their latest run, NULLs last', async () => {
    // PR 1: latest run is short (10s) though an older run took long (900s).
    await run(1, 'failed', 0, 900);
    const pr1Latest = await run(1, 'completed', 100, 10);
    // PR 2: latest run took 120s.
    await run(2, 'completed', 50, 120);
    // PR 3: latest run is still running.
    await run(3, 'completed', 60, 30);
    await run(3, 'running', 200, null);

    const order = (body: { groups: Array<{ pullNumber: number }> }) => body.groups.map((g) => g.pullNumber);
    const desc = await get('groupBy=pr&sort=duration&dir=desc');
    expect(order(desc)).toEqual([2, 1, 3]);
    expect(order(await get('groupBy=pr&sort=duration&dir=asc'))).toEqual([1, 2, 3]);

    const pr1 = desc.groups.find((g: { pullNumber: number }) => g.pullNumber === 1);
    expect(pr1.runs.map((r: { id: string; durationMs: number | null }) => [r.id === pr1Latest, r.durationMs])).toEqual([
      [true, 10_000],
      [false, 900_000],
    ]);
    const pr3 = desc.groups.find((g: { pullNumber: number }) => g.pullNumber === 3);
    expect(pr3.runs.map((r: { durationMs: number | null }) => r.durationMs)).toEqual([null, 30_000]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewRunStatus } from '../core/types.js';
import { createTestDb } from '../db/test-db.js';
import { runRetention, startRetention, type RetentionLogger } from './retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T03:00:00.000Z');
const settings = { provider: 'anthropic' as const, model: 'm', language: 'en' as const, monthlyBudgetUsd: null };

function logger(): RetentionLogger & { lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return { lines, info: (obj) => lines.push(obj), error: (obj) => lines.push(obj) };
}

/** A memory run created `ageDays` before NOW, finished with `status` (or left active). */
async function seed(store: MemoryStore, workspaceId: string, ageDays: number, status: ReviewRunStatus) {
  const run = await store.createReviewRun({
    workspaceId,
    installationId: 1,
    repoFullName: 'acme/api',
    pullNumber: Math.floor(Math.random() * 1e6),
    headSha: 'sha',
    status: status === 'queued' ? 'queued' : 'running',
    costUsd: null,
    detail: null,
  });
  if (status !== 'queued' && status !== 'running') {
    await store.finishReviewRun(workspaceId, run.id, { status, costUsd: 0.1, detail: null });
  }
  const stored = store.runs.get(run.id)!;
  store.runs.set(run.id, { ...stored, createdAt: new Date(NOW.getTime() - ageDays * DAY) });
  return run;
}

describe('run retention job', () => {
  it('deletes only finished runs older than each workspace setting; forever is untouched', async () => {
    const store = new MemoryStore();
    await store.saveSettings({ ...settings, workspaceId: 'ws-90', runRetentionDays: 90 });
    await store.saveSettings({ ...settings, workspaceId: 'ws-forever', runRetentionDays: null });
    const oldDone = await seed(store, 'ws-default', 31, 'completed');
    const oldFailed = await seed(store, 'ws-default', 45, 'failed');
    const young = await seed(store, 'ws-default', 29, 'skipped');
    const oldRunning = await seed(store, 'ws-default', 60, 'running');
    const oldQueued = await seed(store, 'ws-default', 60, 'queued');
    const at60 = await seed(store, 'ws-90', 60, 'completed');
    const at100 = await seed(store, 'ws-90', 100, 'completed');
    const ancient = await seed(store, 'ws-forever', 2000, 'completed');
    const log = logger();

    const result = await runRetention(store, { now: () => NOW, logger: log, sleep: async () => undefined });

    expect(result).toMatchObject({ deleted: 3, workspaces: 2, error: null });
    const left = new Set(store.runs.keys());
    for (const gone of [oldDone, oldFailed, at100]) expect(left.has(gone.id)).toBe(false);
    for (const kept of [young, oldRunning, oldQueued, at60, ancient]) expect(left.has(kept.id)).toBe(true);
    // Spend survives: the deleted runs stay in the monthly usage.
    expect((await store.listMonthlyUsage('ws-default')).reduce((n, u) => n + u.runsTotal, 0)).toBe(3);

    const recorded = await store.getLatestMaintenanceRun('retention');
    expect(recorded).toMatchObject({ id: result!.runId, deletedCount: 3, error: null });
    expect(recorded?.finishedAt).toBeInstanceOf(Date);
    const line = log.lines.find((l) => l.event === 'maintenance.retention');
    expect(line).toMatchObject({ workspaces: 2, deleted: 3, failed: false });
    expect(typeof line?.ms).toBe('number');
  });

  it('deletes in batches with a pause between full batches, and a second run deletes nothing', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) await seed(store, 'ws-1', 40, 'completed');
    const prune = vi.spyOn(store, 'pruneReviewRuns');
    const sleep = vi.fn(async () => undefined);

    const first = await runRetention(store, { now: () => NOW, batchSize: 2, pauseMs: 7, sleep });
    expect(first?.deleted).toBe(5);
    expect(prune.mock.results.length).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);

    const again = await runRetention(store, { now: () => NOW, batchSize: 2, sleep });
    expect(again?.deleted).toBe(0);
  });

  it('the lease prevents a second cleanup while one is running', async () => {
    const store = new MemoryStore();
    await seed(store, 'ws-1', 40, 'completed');
    const log = logger();

    const lease = await startRetention(store, { now: () => NOW });
    expect(lease).not.toBeNull();
    expect(await runRetention(store, { now: () => NOW, logger: log })).toBeNull();
    expect(log.lines.some((l) => l.event === 'maintenance.retention_skipped')).toBe(true);
    expect(store.runs.size).toBe(1);

    expect((await lease!.execute()).deleted).toBe(1);
    expect(await runRetention(store, { now: () => NOW })).not.toBeNull();
  });

  it('records the first error and still cleans the other workspaces', async () => {
    const store = new MemoryStore();
    await seed(store, 'ws-a', 40, 'completed');
    await seed(store, 'ws-b', 40, 'completed');
    const original = store.pruneReviewRuns.bind(store);
    vi.spyOn(store, 'pruneReviewRuns').mockImplementation(async (ws, before, limit) => {
      if (ws === 'ws-a') throw new Error('deadlock detected');
      return original(ws, before, limit);
    });

    const result = await runRetention(store, { now: () => NOW });
    expect(result).toMatchObject({ deleted: 1, error: 'Error: deadlock detected' });
    expect((await store.getLatestMaintenanceRun('retention'))?.error).toBe('Error: deadlock detected');
  });

  it('works against Postgres with old rows (created_at backdated)', { timeout: 20000 }, async () => {
    const { store, client, close } = await createTestDb(undefined, { workspaces: ['ws-pg'] });
    try {
      const base = { workspaceId: 'ws-pg', installationId: 1, repoFullName: 'acme/api', headSha: 's', status: 'running' as const, costUsd: null, detail: null };
      const old = await store.createReviewRun({ ...base, pullNumber: 1 });
      await store.finishReviewRun('ws-pg', old.id, { status: 'completed', costUsd: 0.2, detail: null });
      const fresh = await store.createReviewRun({ ...base, pullNumber: 2 });
      await store.finishReviewRun('ws-pg', fresh.id, { status: 'completed', costUsd: 0.3, detail: null });
      const stuck = await store.createReviewRun({ ...base, pullNumber: 3 });
      await client.query("UPDATE review_runs SET created_at = now() - interval '45 days' WHERE id IN ($1, $2);", [old.id, stuck.id]);

      const result = await runRetention(store);
      expect(result?.deleted).toBe(1);
      expect(await store.getReviewRun('ws-pg', old.id)).toBeNull();
      expect(await store.getReviewRun('ws-pg', fresh.id)).not.toBeNull();
      expect((await store.getReviewRun('ws-pg', stuck.id))?.status).toBe('running');
      expect((await store.getLatestMaintenanceRun('retention'))?.deletedCount).toBe(1);
    } finally {
      await close();
    }
  });
});

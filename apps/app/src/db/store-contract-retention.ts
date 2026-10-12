import { expect, it } from 'vitest';
import {
  RunCountMismatchError,
  RunsNotFoundError,
  usageMonth,
  type AppStore,
  type NewReviewRun,
  type ReviewRun,
  type ReviewRunStatus,
} from '../core/types.js';

const WS = 'ws-k3';
const OTHER = 'ws-k3-other';
const MINUTE = 60 * 1000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/** Usage summary, bulk delete, grouped list, retention and lease part of the AppStore contract. */
export function defineRetentionContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  async function seed(
    store: AppStore,
    overrides: Partial<NewReviewRun>,
    final: ReviewRunStatus = 'completed',
    costUsd: number | null = null,
    tokens?: { inputTokens: number; outputTokens: number },
  ): Promise<ReviewRun> {
    const run = await store.createReviewRun({
      workspaceId: WS,
      installationId: 7,
      repoFullName: 'acme/api',
      pullNumber: 1,
      headSha: `sha-${Math.random().toString(36).slice(2)}`,
      status: 'running',
      costUsd: null,
      detail: null,
      ...overrides,
    });
    if (final !== 'running' && final !== 'queued') {
      await store.finishReviewRun(run.workspaceId, run.id, {
        status: final,
        costUsd,
        detail: null,
        result: tokens
          ? { v: 1, summary: '', highlights: [], findings: [], language: 'en', usage: tokens }
          : undefined,
      });
    }
    await tick();
    return run;
  }

  it('adds every finished run to the monthly usage; deleting runs keeps the spend', async () => {
    const store = await createStore();
    try {
      const a = await seed(store, { pullNumber: 1 }, 'completed', 0.5, { inputTokens: 100, outputTokens: 40 });
      await seed(store, { pullNumber: 2 }, 'failed', 0.25);
      await seed(store, { pullNumber: 3 }, 'skipped');
      await seed(store, { pullNumber: 4 }, 'running');

      const usage = await store.listMonthlyUsage(WS);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        month: usageMonth(a.createdAt),
        runsTotal: 3,
        runsCompleted: 1,
        runsFailed: 1,
        inputTokens: 100,
        outputTokens: 40,
      });
      expect(usage[0]?.costUsd).toBeCloseTo(0.75, 6);

      const monthStart = new Date(Date.UTC(a.createdAt.getUTCFullYear(), a.createdAt.getUTCMonth(), 1));
      expect(await store.monthCostUsd(WS, monthStart)).toBeCloseTo(0.75, 6);

      const deleted = await store.deleteReviewRuns(WS, { ids: [a.id] });
      expect(deleted).toBe(1);
      expect(await store.getReviewRun(WS, a.id)).toBeNull();
      expect(await store.monthCostUsd(WS, monthStart)).toBeCloseTo(0.75, 6);
      expect(await store.monthCostUsd(OTHER, monthStart)).toBe(0);

      await store.deleteWorkspace(WS);
      expect(await store.listMonthlyUsage(WS)).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });

  it('bulk delete by ids never deletes queued/running runs and rejects ids of another workspace', async () => {
    const store = await createStore();
    try {
      const done = await seed(store, { pullNumber: 1 });
      const running = await seed(store, { pullNumber: 2 }, 'running');
      const queued = await seed(store, { pullNumber: 3, status: 'queued' }, 'queued');
      const foreign = await seed(store, { workspaceId: OTHER, pullNumber: 4 });

      await expect(store.deleteReviewRuns(WS, { ids: [done.id, foreign.id] })).rejects.toBeInstanceOf(
        RunsNotFoundError,
      );
      expect(await store.getReviewRun(WS, done.id)).not.toBeNull();
      expect(await store.getReviewRun(OTHER, foreign.id)).not.toBeNull();

      expect(await store.deleteReviewRuns(WS, { ids: [done.id, running.id, queued.id] })).toBe(1);
      expect(await store.getReviewRun(WS, done.id)).toBeNull();
      expect((await store.getReviewRun(WS, running.id))?.status).toBe('running');
      expect((await store.getReviewRun(WS, queued.id))?.status).toBe('queued');
    } finally {
      await cleanup?.();
    }
  });

  it('bulk delete by filters checks the matching count first and keeps active runs', async () => {
    const store = await createStore();
    try {
      await seed(store, { repoFullName: 'acme/web', pullNumber: 1 });
      await seed(store, { repoFullName: 'acme/web', pullNumber: 2 }, 'failed');
      await seed(store, { repoFullName: 'acme/web', pullNumber: 3 }, 'running');
      const kept = await seed(store, { repoFullName: 'acme/api', pullNumber: 1 });
      const filters = { repo: ['acme/web'] };

      const mismatch = await store.deleteReviewRuns(WS, { filters, expectedCount: 2 }).catch((e: unknown) => e);
      expect(mismatch).toBeInstanceOf(RunCountMismatchError);
      expect((mismatch as RunCountMismatchError).actual).toBe(3);
      expect((await store.listReviewRuns(WS, { ...filters, limit: 10 })).total).toBe(3);

      expect(await store.deleteReviewRuns(WS, { filters, expectedCount: 3 })).toBe(2);
      const left = await store.listReviewRuns(WS, { limit: 10 });
      expect(left.runs.map((r) => r.status).sort()).toEqual(['completed', 'running']);
      expect(left.runs.some((r) => r.id === kept.id)).toBe(true);
    } finally {
      await cleanup?.();
    }
  });

  it('groups runs by PR: paging over groups, filters inside groups, sort by the latest run', async () => {
    const store = await createStore();
    try {
      await seed(store, { repoFullName: 'acme/api', pullNumber: 5 }, 'failed', 0.1, { inputTokens: 10, outputTokens: 1 });
      await seed(store, { repoFullName: 'acme/api', pullNumber: 5 }, 'completed', 0.2, { inputTokens: 20, outputTokens: 2 });
      await seed(store, { repoFullName: 'acme/api', pullNumber: 9 }, 'completed');
      await seed(store, { repoFullName: 'acme/web', pullNumber: 5 }, 'failed');

      const all = await store.listReviewRunGroups(WS, { sort: 'createdAt', dir: 'desc', limit: 2 });
      expect(all.total).toBe(3);
      expect(all.totalRuns).toBe(4);
      expect(all.groups.map((g) => `${g.repoFullName}#${g.pullNumber}`)).toEqual(['acme/web#5', 'acme/api#9']);

      const page2 = await store.listReviewRunGroups(WS, { sort: 'createdAt', dir: 'desc', limit: 2, offset: 2 });
      expect(page2.groups).toHaveLength(1);
      const pr5 = page2.groups[0]!;
      expect(pr5).toMatchObject({ repoFullName: 'acme/api', pullNumber: 5, runCount: 2, inputTokens: 30, outputTokens: 3 });
      expect(pr5.costUsd).toBeCloseTo(0.3, 6);
      expect(pr5.runs.map((r) => r.status)).toEqual(['completed', 'failed']);

      const failedOnly = await store.listReviewRunGroups(WS, { status: ['failed'], sort: 'repo', dir: 'asc' });
      expect(failedOnly.totalRuns).toBe(2);
      expect(failedOnly.groups.map((g) => [g.repoFullName, g.runs.length])).toEqual([
        ['acme/api', 1],
        ['acme/web', 1],
      ]);
      expect(failedOnly.groups[1]?.costUsd).toBeNull();
      expect(failedOnly.groups[1]?.inputTokens).toBeNull();
    } finally {
      await cleanup?.();
    }
  });

  it('retention: policies default to 30 days, forever is skipped, prune deletes finished runs in batches', async () => {
    const store = await createStore();
    try {
      await seed(store, { pullNumber: 1 });
      await seed(store, { pullNumber: 2 });
      await seed(store, { pullNumber: 3 }, 'failed');
      const active = await seed(store, { pullNumber: 4 }, 'running');
      await seed(store, { workspaceId: OTHER, pullNumber: 1 });

      expect(await store.listRetentionPolicies()).toEqual(
        expect.arrayContaining([{ workspaceId: WS, retentionDays: 30 }, { workspaceId: OTHER, retentionDays: 30 }]),
      );
      const base = { provider: 'anthropic' as const, model: 'm', language: 'en' as const, monthlyBudgetUsd: null };
      await store.saveSettings({ ...base, workspaceId: OTHER, runRetentionDays: null });
      await store.saveSettings({ ...base, workspaceId: WS, runRetentionDays: 90 });
      const policies = await store.listRetentionPolicies();
      expect(policies.find((p) => p.workspaceId === WS)?.retentionDays).toBe(90);
      expect(policies.some((p) => p.workspaceId === OTHER)).toBe(false);

      // Nothing is older than a minute ago.
      expect(await store.pruneReviewRuns(WS, new Date(Date.now() - MINUTE), 10)).toBe(0);
      const later = new Date(Date.now() + MINUTE);
      expect(await store.pruneReviewRuns(WS, later, 2)).toBe(2);
      expect(await store.pruneReviewRuns(WS, later, 2)).toBe(1);
      expect(await store.pruneReviewRuns(WS, later, 2)).toBe(0);
      expect((await store.getReviewRun(WS, active.id))?.status).toBe('running');
      expect((await store.listReviewRuns(OTHER, 10)).length).toBe(1);
    } finally {
      await cleanup?.();
    }
  });

  it('maintenance lease: one unfinished run per kind; a stale lease is closed as abandoned', async () => {
    const store = await createStore();
    try {
      const past = new Date(Date.now() - MINUTE);
      const first = await store.startMaintenanceRun('retention', past);
      expect(first).not.toBeNull();
      expect(await store.startMaintenanceRun('retention', past)).toBeNull();

      await store.finishMaintenanceRun(first!.id, { deletedCount: 12, error: null });
      const latest = await store.getLatestMaintenanceRun('retention');
      expect(latest).toMatchObject({ id: first!.id, deletedCount: 12, error: null });
      expect(latest?.finishedAt).toBeInstanceOf(Date);

      const second = await store.startMaintenanceRun('retention', past);
      expect(second).not.toBeNull();
      // A lease older than the stale cutoff (here: anything before a minute from now) is taken over.
      const third = await store.startMaintenanceRun('retention', new Date(Date.now() + MINUTE));
      expect(third).not.toBeNull();
      expect(third!.id).not.toBe(second!.id);
    } finally {
      await cleanup?.();
    }
  });
}

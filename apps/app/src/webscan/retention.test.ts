import { describe, expect, it, vi } from 'vitest';
import { runWebScanRetention } from './retention.js';
import type { WebScanStore } from './store.js';
import type { WebScanWorkerStore } from './worker-store.js';

/**
 * The retention of the scanner (ADR-0052 section 11).
 *
 * The order matters: the tombstones are pruned while the completed scan that proves
 * them fixed still exists, and only then do the snapshots go.
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');

function harness(overrides: { sites?: number; retentionDays?: number } = {}) {
  const order: string[] = [];
  const sites = Array.from({ length: overrides.sites ?? 1 }, (_value, index) => ({
    id: `site-${index}`,
  }));

  const store = {
    getSettings: vi.fn(async () => ({ retentionDays: overrides.retentionDays ?? 365 })),
    listSites: vi.fn(async () => sites),
    restoreExpiredExceptionOccurrences: vi.fn(async (siteId: string) => {
      order.push(`restore:${siteId}`);
      return 1;
    }),
    archiveUnprovenOccurrences: vi.fn(async (siteId: string) => {
      order.push(`archive:${siteId}`);
      return 2;
    }),
    pruneProvenFixedTombstones: vi.fn(async (siteId: string) => {
      order.push(`prune:${siteId}`);
      return 3;
    }),
  } as unknown as WebScanStore;

  const workerStore = {
    pruneExpiredScans: vi.fn(async () => {
      order.push('prune-snapshots');
      return 4;
    }),
    appendAuditSummary: vi.fn(async () => {
      order.push('audit');
    }),
  } as unknown as WebScanWorkerStore;

  return { store, workerStore, order };
}

describe('the retention of the website scanner', () => {
  it('restores, archives and prunes in that order, then deletes the snapshots', async () => {
    const h = harness();

    const result = await runWebScanRetention({
      store: h.store,
      workerStore: h.workerStore,
      now: () => NOW,
    });

    expect(h.order).toEqual([
      'restore:site-0',
      'archive:site-0',
      'prune:site-0',
      'prune-snapshots',
      'audit',
    ]);
    expect(result).toMatchObject({
      sites: 1,
      restoredOccurrences: 1,
      archivedOccurrences: 2,
      prunedTombstones: 3,
      prunedScans: 4,
    });
  });

  it('prunes the snapshots with the retention horizon of the settings', async () => {
    const h = harness();
    const prune = vi.fn(async () => 0);

    await runWebScanRetention({
      store: h.store,
      workerStore: { ...h.workerStore, pruneExpiredScans: prune } as unknown as WebScanWorkerStore,
      now: () => NOW,
    });

    // The cutoff is the retention horizon of the settings, and the call is bounded.
    expect(prune).toHaveBeenCalledWith({
      olderThan: new Date(NOW.getTime() - 365 * 86_400_000),
      limit: expect.any(Number),
    });
  });

  it('writes the audit summary of the pass', async () => {
    const h = harness();

    await runWebScanRetention({
      store: h.store,
      workerStore: h.workerStore,
      now: () => NOW,
    });

    expect(h.workerStore.appendAuditSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scan.retention',
        after: expect.objectContaining({ retentionDays: 365, prunedScans: 4 }),
      }),
    );
  });

  it('touches a bounded number of sites and reports the rest', async () => {
    const h = harness({ sites: 5 });

    const result = await runWebScanRetention({
      store: h.store,
      workerStore: h.workerStore,
      siteBatch: 2,
      now: () => NOW,
    });

    expect(result.sites).toBe(2);
    expect(result.remainingSites).toBe(3);
    expect(h.store.listSites).toHaveBeenCalledTimes(1);
  });

  it('reaches every site over the following nights when there are more than one batch', async () => {
    const h = harness({ sites: 5 });
    const day = 86_400_000;

    for (let night = 0; night < 3; night += 1) {
      await runWebScanRetention({
        store: h.store,
        workerStore: h.workerStore,
        siteBatch: 2,
        now: () => new Date(NOW.getTime() + night * day),
      });
    }

    const touched = new Set(
      h.order.filter((entry) => entry.startsWith('restore:')).map((entry) => entry.slice('restore:'.length)),
    );
    expect([...touched].sort()).toEqual(['site-0', 'site-1', 'site-2', 'site-3', 'site-4']);
  });
});

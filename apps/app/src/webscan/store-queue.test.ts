import { describe, expect, it } from 'vitest';
import type { ScanScope } from '@mergepilot/webscan';
import { defaultScope } from './pg-rows.js';
import { fixture, registeredSite, unpause } from './store.fixtures.js';
import { WebScanConflictError, WebScanPausedError } from './store.js';

/**
 * The queue of the scanner (ADR-0052 section 7).
 *
 * A queued scan is a durable intent, not a request that is in flight: it is written
 * together with its audit row, and the idempotency key of a manual request turns a
 * repeated request into a replay instead of a second scan.
 */

describe('queuing a scan', () => {
  it('refuses to queue while the scanner is paused', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      await expect(
        store.enqueueManualScan('admin-1', { siteId: site.id, idempotencyKey: 'key-1' }),
      ).rejects.toBeInstanceOf(WebScanPausedError);
    } finally {
      await db.close();
    }
  });

  it('replays the same idempotency key and conflicts on a different request', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);

      const first = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      expect(first.replayed).toBe(false);

      const replay = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      expect(replay.replayed).toBe(true);
      expect(replay.scan.id).toBe(first.scan.id);

      const otherScope: ScanScope = {
        ...defaultScope('example.com', 'https://example.com'),
        crawlPaths: [{ path: '/app', kind: 'prefix' }],
      };
      await expect(
        store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-1',
          scope: otherScope,
        }),
      ).rejects.toBeInstanceOf(WebScanConflictError);

      expect(await store.listScans(site.id)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('writes the queued intent and its audit row together', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });

      expect(scan.status).toBe('queued');
      expect(scan.outboxState).toBe('pending');

      const audit = await store.listAudit({ targetType: 'scan', targetId: scan.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('scan.enqueue');
    } finally {
      await db.close();
    }
  });

  it('queues one scheduled scan per slot and advances the schedule', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await store.updateSite('admin-1', site.id, {
        schedule: { frequency: 'daily', hour: 4, minute: 0, enabled: true },
      });

      const slot = new Date('2026-11-02T04:00:00.000Z');
      // The schedule is evaluated at a fixed moment, so the advance of the schedule is
      // the next occurrence strictly beyond that moment.
      const now = new Date('2026-11-02T05:00:00.000Z');
      const first = await store.enqueueScheduledScan('scheduler', {
        siteId: site.id,
        scheduledFor: slot,
        now,
      });
      expect(first.trigger).toBe('scheduled');
      expect(first.scheduledFor).toEqual(slot);

      const again = await store.enqueueScheduledScan('scheduler', {
        siteId: site.id,
        scheduledFor: slot,
        now,
      });
      expect(again.id).toBe(first.id);
      expect(await store.listScans(site.id)).toHaveLength(1);

      const updated = await store.getSite(site.id);
      expect(updated?.nextRunAt).not.toBeNull();
      // The daily occurrence at 04:00 Kuwait of the next day.
      expect(updated!.nextRunAt!.toISOString()).toBe('2026-11-03T01:00:00.000Z');
      expect(updated!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    } finally {
      await db.close();
    }
  });
});

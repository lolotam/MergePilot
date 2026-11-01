import { describe, expect, it } from 'vitest';
import type { CheckSwitches } from '@mergepilot/webscan';
import { defaultScope } from './pg-rows.js';
import { fixture, registeredSite, unpause } from './store.fixtures.js';
import { WebScanConflictError } from './store.js';

/**
 * The idempotency of a manual request (ADR-0052 section 7).
 *
 * The key of a request identifies the request, not the state of the installation. The
 * fingerprint therefore covers the request data only. A change of the server side
 * defaults between two identical requests is not a different request, so it must not
 * turn the second request into a conflict.
 */

/** The check switches of the shipped defaults. */
const DEFAULT_CHECKS: CheckSwitches = {
  headers: true,
  cookies: true,
  transport: true,
  disclosure: true,
  files: true,
  active: false,
};

describe('the idempotency of a manual request', () => {
  it('replays the original scan after the installation defaults changed', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);

      const first = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      expect(first.replayed).toBe(false);

      // The installation changes: new limits, new checks, a new contact.
      await store.updateSettings('admin-1', {
        limits: { maxRequests: 7 },
        checks: { ...DEFAULT_CHECKS, active: true },
        contact: 'security@example.com',
      });

      const replay = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      expect(replay.replayed).toBe(true);
      expect(replay.scan.id).toBe(first.scan.id);
      expect(await store.listScans(site.id)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('still conflicts when the request itself differs', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await store.enqueueManualScan('admin-1', { siteId: site.id, idempotencyKey: 'key-1' });

      await expect(
        store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-1',
          scope: {
            ...defaultScope('example.com', 'https://example.com'),
            crawlPaths: [{ path: '/app', kind: 'prefix' }],
          },
        }),
      ).rejects.toBeInstanceOf(WebScanConflictError);

      expect(await store.listScans(site.id)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('keeps the sites apart', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const first = await registeredSite(store, 'first.example.com');
      const second = await registeredSite(store, 'second.example.com');

      await store.enqueueManualScan('admin-1', { siteId: first.id, idempotencyKey: 'key-1' });
      const other = await store.enqueueManualScan('admin-1', {
        siteId: second.id,
        idempotencyKey: 'key-1',
      });

      expect(other.replayed).toBe(false);
      expect(other.scan.siteId).toBe(second.id);
    } finally {
      await db.close();
    }
  });

  it('persists the effective settings next to the scan', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await store.updateSettings('admin-1', { contact: 'security@example.com' });

      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });

      // The scan records the settings it was queued under, next to the fingerprint of
      // the request. The two are not the same thing.
      expect(scan.effectiveSettings?.contact).toBe('security@example.com');
      expect(scan.effectiveSettings?.limits).toMatchObject({ maxRequests: 500 });
    } finally {
      await db.close();
    }
  });
});

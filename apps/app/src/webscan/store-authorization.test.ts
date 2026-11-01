import { describe, expect, it } from 'vitest';
import { defaultScope } from './pg-rows.js';
import { fixture, registeredSite, unpause } from './store.fixtures.js';

/**
 * The authorization of a site (ADR-0052 section 6 and section 7).
 *
 * The scope version is the fence of the queued work. It moves when the authorization
 * covers something else, and only then: a fresh authorization of the same scope
 * replaces the old one without invalidating the work that was queued under it.
 */

describe('the authorization of a site', () => {
  it('keeps the scope version and the queued work of a pure re-authorization', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      const before = await store.getSite(site.id);

      const reauthorized = await store.updateSite('admin-1', site.id, { authorizedBy: 'admin-2' });

      // The scope did not change, so the fence did not move and the queued work is
      // still valid.
      expect(reauthorized.authorization.scopeVersion).toBe(before?.authorization.scopeVersion);
      expect(reauthorized.authorization.authorizedBy).toBe('admin-2');
      expect((await store.getScan(scan.id))?.status).toBe('queued');
    } finally {
      await db.close();
    }
  });

  it('records the fresh authorization of a pure re-authorization in the audit log', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      await store.updateSite('admin-1', site.id, { authorizedBy: 'admin-2' });

      const audit = await store.listAudit({ targetType: 'site', targetId: site.id });
      const authorization = audit.filter((entry) => entry.action === 'site.authorize');
      expect(authorization).toHaveLength(1);
      expect(authorization[0]?.actor).toBe('admin-1');
      expect(authorization[0]?.after).toMatchObject({ authorizedBy: 'admin-2' });
    } finally {
      await db.close();
    }
  });

  it('moves the scope version and stops the queued work when the scope changes', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      const before = await store.getSite(site.id);

      const changed = await store.updateSite('admin-1', site.id, {
        scope: {
          ...defaultScope('example.com', 'https://example.com'),
          crawlPaths: [{ path: '/app', kind: 'prefix' }],
        },
      });

      expect(changed.authorization.scopeVersion).toBe((before?.authorization.scopeVersion ?? 0) + 1);
      const stopped = await store.getScan(scan.id);
      expect(stopped?.status).toBe('stopped');
      expect(stopped?.stopReason).toBe('authorization_revoked');
    } finally {
      await db.close();
    }
  });

  it('moves the scope version and stops the queued work when the schedule changes', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      const before = await store.getSite(site.id);

      const changed = await store.updateSite('admin-1', site.id, {
        schedule: { frequency: 'daily', hour: 4, minute: 0, enabled: true },
      });

      expect(changed.authorization.scopeVersion).toBe((before?.authorization.scopeVersion ?? 0) + 1);
      expect((await store.getScan(scan.id))?.status).toBe('stopped');
    } finally {
      await db.close();
    }
  });
});

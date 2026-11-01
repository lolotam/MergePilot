import { describe, expect, it } from 'vitest';
import { fixture, registeredSite, unpause } from './store.fixtures.js';
import { PgWebScanWorkerStore } from './worker-store-persistence.js';

describe('the live scan authorization and attempt', () => {
  it('keeps the original authorizer after reauthorization and reads live verification', async () => {
    const { db, store } = await fixture();
    try {
      await db.client.query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES
        ('admin-1', 'First admin', 'first@example.com', true),
        ('admin-2', 'Second admin', 'second@example.com', true)`);
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'live-original-authorizer',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      const attempt = { scanId: queued.scan.id, attemptId: 'live-attempt' };
      await worker.claimScan({ ...attempt, now: new Date() });
      await store.updateSite('admin-2', site.id, { authorizedBy: 'admin-2' });

      expect(await worker.readLiveScanState(site.id, attempt)).toMatchObject({
        scopeVersion: queued.scan.scopeVersion,
        attemptOwned: true,
        administrator: { id: 'admin-2', emailVerified: true },
        authorizingAdministrator: { id: 'admin-1', emailVerified: true },
      });
      await db.client.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', ['admin-1']);
      expect(await worker.readLiveScanState(site.id, attempt)).toMatchObject({
        authorizingAdministrator: { id: 'admin-1', emailVerified: false },
      });
    } finally {
      await db.close();
    }
  });

  it('refuses to attach an attempt or its authorizer to another site', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const first = await registeredSite(store);
      const second = await registeredSite(store, 'second.example.com');
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: first.id,
        idempotencyKey: 'site-bound-attempt',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      const attempt = { scanId: queued.scan.id, attemptId: 'site-bound' };
      await worker.claimScan({ ...attempt, now: new Date() });

      expect(await worker.readLiveScanState(second.id, attempt)).toMatchObject({
        attemptOwned: false,
        authorizingAdministrator: null,
      });
    } finally {
      await db.close();
    }
  });

  it('refuses a stale attempt and a scan that already reached a terminal state', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'terminal-attempt',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      const attempt = { scanId: queued.scan.id, attemptId: 'owner' };
      await worker.claimScan({ ...attempt, now: new Date() });
      expect(await worker.readLiveScanState(site.id, { ...attempt, attemptId: 'stale' }))
        .toMatchObject({ attemptOwned: false });
      await worker.recordScanOutcomeAttempt('worker:owner', {
        ...attempt,
        siteId: site.id,
        now: new Date(),
        status: 'completed',
        requests: 0,
        pages: 0,
        durationMs: 0,
        findings: [],
        coverage: [],
        updates: [],
      });
      expect(await worker.readLiveScanState(site.id, attempt)).toMatchObject({ attemptOwned: false });
    } finally {
      await db.close();
    }
  });
});

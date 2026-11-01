import { describe, expect, it, vi } from 'vitest';
import { createScanAbortController } from './abort.js';
import { processScanJob, type WebScanWorkerDeps } from './worker.js';
import type { WebScanScan, WebScanSite } from './types.js';
import { harness, observation, scan, site } from './worker.fixtures.js';

/**
 * The stops of the scan worker (ADR-0052 sections 5 and 7).
 *
 * The worker runs what was authorized: the settings of the scan are the ones it was
 * queued with, and the scope version of the site must still be the version the scan
 * was queued under. A run that is aborted stops, and it says why with a fixed reason.
 */

describe('the stops of the scan worker', () => {
  it('runs the settings the scan was queued with and not the current defaults', async () => {
    const h = harness();

    await processScanJob('scan-1', h.deps);

    const input = h.runScan.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      contact: 'security@example.com',
      limits: { maxRequests: 10, maxPages: 2 },
      scope: { hostname: 'example.com' },
    });
  });

  it('stops the scan when the scope version of the site changed after the queue', async () => {
    const h = harness({ siteScopeVersion: 2 });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.stopQueuedScan).toHaveBeenCalledWith({
      scanId: 'scan-1',
      reason: 'scope_changed',
      now: expect.any(Date),
    });
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('stops the scan when the administrator of the queued authorization is gone', async () => {
    // The site was authorized again by another administrator. The queued scan stays
    // bound to the administrator that authorized it.
    const h = harness({
      administrator: { id: 'admin-2', email: 'admin2@example.com', emailVerified: true },
      audit: [{ id: 'audit-1', action: 'site.authorize', after: { authorizedBy: 'admin-1' } }],
    });
    h.deps.store.getSite = vi.fn(async () =>
      ({
        ...site,
        authorization: {
          ...site.authorization,
          auditId: 'audit-2',
          authorizedBy: 'admin-2',
          scopeVersion: 1,
        },
      }) as unknown as WebScanSite,
    ) as unknown as WebScanWorkerDeps['store']['getSite'];
    h.deps.workerStore.loadAdministratorIdentity = vi.fn(async (userId: string) =>
      userId === 'admin-1'
        ? null
        : { id: 'admin-2', email: 'admin2@example.com', emailVerified: true },
    ) as unknown as WebScanWorkerDeps['workerStore']['loadAdministratorIdentity'];

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.stopQueuedScan).toHaveBeenCalledWith({
      scanId: 'scan-1',
      reason: 'authorization_revoked',
      now: expect.any(Date),
    });
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('stops the scan when the record of the queued settings cannot be read', async () => {
    const h = harness({ scan: { ...scan, effectiveSettings: {} } as unknown as WebScanScan });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.recordScanOutcomeAttempt).toHaveBeenCalledTimes(1);
    expect(h.recordScanOutcomeAttempt.mock.calls[0]?.[1]).toMatchObject({
      status: 'stopped',
      stopReason: 'settings_unreadable',
    });
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('stops the scan when the queued record has no usable contact', async () => {
    const h = harness({
      scan: {
        ...scan,
        effectiveSettings: { ...scan.effectiveSettings, contact: '' },
      } as unknown as WebScanScan,
    });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.recordScanOutcomeAttempt.mock.calls[0]?.[1]).toMatchObject({
      status: 'stopped',
      stopReason: 'contact_unusable',
    });
  });

  it('stops the run when the owner aborts it', async () => {
    const h = harness();
    const abort = createScanAbortController();
    h.deps.runScan = vi.fn(async (_input, scanDeps) => {
      // The cancel arrives while the scan runs.
      abort.abort('cancelled');
      expect(scanDeps.signal.aborted).toBe(true);
      return { ...observation, status: 'stopped', reason: 'cancelled' };
    }) as unknown as WebScanWorkerDeps['runScan'];

    await expect(processScanJob('scan-1', h.deps, { abort })).resolves.toBe('stopped');
    expect(h.recordScanOutcomeAttempt).toHaveBeenCalledTimes(1);
    expect(h.recordScanOutcomeAttempt.mock.calls[0]?.[1]).toMatchObject({
      status: 'stopped',
      stopReason: 'cancelled',
    });
  });

  it('aborts the run when the lease connection is lost', async () => {
    const h = harness();
    const abort = createScanAbortController();
    let lost: (() => void) | undefined;
    (h.deps.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
      const client = {
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          return { rows: [] };
        },
        on: (_event: string, handler: () => void) => {
          lost = handler;
          return client;
        },
        removeListener: () => client,
        release: () => {},
      };
      return client;
    };
    h.deps.runScan = vi.fn(async (_input, scanDeps) => {
      // The lease dies while the scan is in flight.
      lost?.();
      await scanDeps.fetch('https://example.com/');
      return observation;
    }) as unknown as WebScanWorkerDeps['runScan'];

    await expect(processScanJob('scan-1', h.deps, { abort })).resolves.toBe('stopped');
    expect(abort.reason).toBe('lease_lost');
    expect(h.recordScanOutcomeAttempt.mock.calls[0]?.[1]).toMatchObject({
      status: 'stopped',
      stopReason: 'lease_lost',
    });
  });

  it('never claims a scan when the run was aborted before it started', async () => {
    const h = harness();
    const abort = createScanAbortController();
    abort.abort('shutdown');

    await expect(processScanJob('scan-1', h.deps, { abort })).resolves.toBe('stopped');
    expect(h.claimScan).not.toHaveBeenCalled();
    expect(h.runScan).not.toHaveBeenCalled();
    expect(h.stopQueuedScan).toHaveBeenCalledWith({
      scanId: 'scan-1',
      reason: 'shutdown',
      now: expect.any(Date),
    });
  });
});

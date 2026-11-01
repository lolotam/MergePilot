import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createScanAbortController } from '../../src/webscan/abort.js';
import { PgWebScanStore } from '../../src/webscan/pg-store.js';
import { PgWebScanWorkerStore } from '../../src/webscan/worker-store-persistence.js';
import { processScanJob, type WebScanWorkerDeps } from '../../src/webscan/worker.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import {
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
  type TestPostgresContext,
} from './test-helper.js';

/**
 * The scan worker on a real Postgres.
 *
 * The lease of the scanner is a PostgreSQL advisory lock on a dedicated connection. The
 * loss of that connection has to stop the scan, and the findings the scan already
 * observed have to survive the stop.
 *
 * Every request of the scan is served by the transport of the fixture. The fixture
 * never opens a socket, so nothing leaves the machine.
 */

if (!hasIntegrationEnv) {
  describe.skip('the web scan worker on real Postgres (skipped: no integration env)', () => {
    it.skip('skipped', () => {});
  });
} else {
  const masterKey = randomBytes(32).toString('base64');
  const platformAdmins = ['admin@example.com'];
  const hostname = '127.0.0.1';
  const baseUrl = 'https://127.0.0.1';

  interface Fixture {
    context: TestPostgresContext;
    store: PgWebScanStore;
    workerStore: PgWebScanWorkerStore;
    scanId: string;
    siteId: string;
    /** The pool the lease is taken from. */
    leasePool: Pool;
  }

  async function fixture(): Promise<Fixture> {
    const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
    await context.pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)`,
      ['admin-1', 'Admin', platformAdmins[0]],
    );
    const store = new PgWebScanStore(context.db, new PurposeScopedVault({ masterKey }));
    const workerStore = new PgWebScanWorkerStore(context.db);
    await store.updateSettings('admin-1', { paused: false, contact: 'security@example.com' });
    const site = await store.createSite('admin-1', {
      hostname,
      baseUrl,
      ownerUserId: 'admin-1',
      scope: {
        hostname,
        baseUrl,
        crawlPaths: [{ path: '/', kind: 'prefix' }],
        blockedPaths: [],
        parameterizedPaths: [],
        activePaths: [],
        extraFilePaths: [],
      },
      authorizedBy: 'admin-1',
    });
    const queued = await store.enqueueManualScan('admin-1', {
      siteId: site.id,
      idempotencyKey: 'key-1',
    });
    const leasePool = new Pool({
      connectionString: context.connectionString,
      application_name: 'webscan-lease-fixture',
    });
    return {
      context,
      store,
      workerStore,
      scanId: queued.scan.id,
      siteId: site.id,
      leasePool,
    };
  }

  /** The page of the fixture: a site without the headers a browser wants. */
  function fixturePage(): Response {
    return new Response('<html><head><title>fixture</title></head><body>fixture</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  /**
   * The transport of the fixture.
   *
   * The page of the site is served. Every other request - the probe of the transport
   * check - waits for the abort of the run, so the run is in flight when it is stopped.
   */
  function fixtureTransport(onRequest: (url: string) => void): WebScanWorkerDeps['createFetch'] {
    return () => async (url: string, init: { signal: AbortSignal }) => {
      onRequest(url);
      if (url.startsWith(baseUrl)) return fixturePage();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = (): void => reject(init.signal.reason);
        if (init.signal.aborted) {
          onAbort();
          return;
        }
        init.signal.addEventListener('abort', onAbort, { once: true });
      });
      return new Response('never');
    };
  }

  function workerDeps(f: Fixture, transport: WebScanWorkerDeps['createFetch']): WebScanWorkerDeps {
    // The store of the worker is the shared store plus the capability that opens the
    // identity key of a site. The prototype of the store is kept, so every method of
    // it stays bound to the store.
    const store = new Proxy(f.store, {
      get(target, property, receiver): unknown {
        if (property === 'openSiteIdentityKey') {
          return async (): Promise<string> => Buffer.alloc(32, 3).toString('base64');
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return {
      store,
      workerStore: f.workerStore,
      pool: f.leasePool,
      platformAdmins,
      createFetch: transport,
      now: () => new Date(),
    } as unknown as WebScanWorkerDeps;
  }

  describe('the web scan worker on real Postgres', () => {
    it('stops the scan when the connection of the lease is lost', async () => {
      const f = await fixture();
      const requests: string[] = [];
      const abort = createScanAbortController();
      try {
        const deps = workerDeps(f, fixtureTransport((url) => requests.push(url)));

        const run = processScanJob(f.scanId, deps, { abort });
        // The lease connection is killed while the scan is in flight.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await f.context.pool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'webscan-lease-fixture'`,
        );

        await expect(run).resolves.toBe('stopped');
        // The worker knows why it stopped.
        expect(abort.reason).toBe('lease_lost');
        const scan = await f.store.getScan(f.scanId);
        expect(scan?.status).toBe('stopped');
        expect(scan?.stopReason).toBe('lease_lost');
        // The scan did not keep sending requests after the lease was gone.
        expect(requests.length).toBeLessThanOrEqual(2);
      } finally {
        await f.leasePool.end();
        await f.context.close();
      }
    });

    it('keeps the findings a scan observed before a cancel stopped it', async () => {
      const f = await fixture();
      const abort = createScanAbortController();
      try {
        const deps = workerDeps(f, fixtureTransport(() => {}));
        const run = processScanJob(f.scanId, deps, { abort });
        // The cancel arrives while the scan is in flight.
        await new Promise((resolve) => setTimeout(resolve, 500));
        abort.abort('cancelled');

        await expect(run).resolves.toBe('stopped');
        const scan = await f.store.getScan(f.scanId);
        expect(scan?.status).toBe('stopped');
        expect(scan?.stopReason).toBe('cancelled');

        // The finding the scan observed before the stop survived it.
        const findings = await f.context.pool.query<{
          issue_id: string;
          comparison: string;
          severity: string;
        }>(
          `SELECT issue_id, comparison, severity FROM web_scan_findings WHERE scan_id = $1`,
          [f.scanId],
        );
        expect(findings.rows.length).toBeGreaterThan(0);
        expect(findings.rows.map((row) => row.issue_id)).toContain(
          'missing-strict-transport-security',
        );
        // A stopped run is not a baseline: it never proves that anything is fixed.
        expect(findings.rows.every((row) => row.comparison !== 'Fixed')).toBe(true);

        // The coverage of the run is kept with the scan.
        expect(scan?.coverageSummary ?? []).not.toHaveLength(0);

        // The ledger keeps the occurrence as outstanding.
        const occurrences = await f.context.pool.query<{
          issue_id: string;
          state: string;
          comparison: string | null;
        }>(
          `SELECT issue_id, state, comparison FROM web_scan_occurrences WHERE site_id = $1`,
          [f.siteId],
        );
        expect(occurrences.rows.length).toBeGreaterThan(0);
        expect(occurrences.rows.every((row) => row.state === 'outstanding')).toBe(true);
        expect(occurrences.rows.every((row) => row.comparison !== 'Fixed')).toBe(true);

        // The site has no baseline: only a completed scan writes the coverage of a site.
        const site = await f.context.pool.query<{
          last_coverage_summary: unknown;
          last_coverage_scan_id: string | null;
        }>(`SELECT last_coverage_summary, last_coverage_scan_id FROM web_scan_sites WHERE id = $1`, [
          f.siteId,
        ]);
        expect(site.rows[0]?.last_coverage_summary).toBeNull();
        expect(site.rows[0]?.last_coverage_scan_id).toBeNull();
      } finally {
        await f.leasePool.end();
        await f.context.close();
      }
    });
  });
}

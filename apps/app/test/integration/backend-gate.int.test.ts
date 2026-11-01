import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Worker } from 'bullmq';
import type { ReviewJob } from '../../src/core/types.js';
import { BullMqReviewQueue, createQueueConnection } from '../../src/queue/bullmq-queue.js';
import { PgWebScanStore } from '../../src/webscan/pg-store.js';
import { defaultScope } from '../../src/webscan/pg-rows.js';
import { nextScheduledRun } from '../../src/webscan/schedule.js';
import type { WebScanSchedule } from '../../src/webscan/types.js';
import {
  applyGlobalConcurrency,
  createWebScanQueue,
  publishScanJob,
  scanJobId,
  WEB_SCAN_QUEUE_NAME,
} from '../../src/webscan/queue.js';
import { WebScanNotFoundError, WebScanPausedError } from '../../src/webscan/store.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import {
  GATE_MASTER_KEY,
  openIndependentConnection,
  withTimeout,
} from './backend-gate.fixtures.js';
import {
  clearRedis,
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
  INTEGRATION_REDIS_URL,
  type TestPostgresContext,
} from './test-helper.js';

/**
 * The backend integration gate of the website security scanner (ADR-0052).
 *
 * These cases run against a real PostgreSQL and a real Redis, because the guarantees
 * they check are exactly the ones a single-process database or an in-memory queue
 * cannot show: a decision that must be taken from the committed state of another
 * process, an intent that must survive the process that wrote it, and a scanner that
 * must not depend on the capacity of the review queue.
 *
 * Nothing here contacts a target site. No scan is executed and no outbound request is
 * made; the gate stops at the durable intent.
 */

if (!hasIntegrationEnv) {
  describe.skip('the web scan backend gate on real PostgreSQL and Redis (skipped: no integration env)', () => {
    it.skip('skipped', () => {});
  });
} else {
  /** A store over the schema of the given context. */
  function storeOf(context: TestPostgresContext): PgWebScanStore {
    return new PgWebScanStore(context.db, new PurposeScopedVault({ masterKey: GATE_MASTER_KEY }));
  }

  /** A site that is registered and authorized. */
  async function registeredSite(store: PgWebScanStore, hostname: string) {
    return store.createSite('admin-1', {
      hostname,
      baseUrl: `https://${hostname}`,
      ownerUserId: 'admin-1',
      scope: defaultScope(hostname, `https://${hostname}`),
      authorizedBy: 'admin-1',
    });
  }

  describe('the web scan backend gate on real PostgreSQL and Redis', () => {
    it('a migrated empty installation cannot initiate a request', async () => {
      const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
      try {
        const store = storeOf(context);

        // The shipped defaults of a fresh installation.
        const settings = await store.getSettings();
        expect(settings.paused).toBe(true);
        expect(settings.alertsEnabled).toBe(false);
        expect(settings.defaultSchedule.enabled).toBe(false);
        expect(settings.approvedInstallations).toEqual([]);
        expect(await store.listSites()).toEqual([]);

        // The kill switch refuses both request kinds.
        await expect(
          store.enqueueManualScan('admin-1', {
            siteId: randomUUID(),
            idempotencyKey: 'gate-empty-manual',
          }),
        ).rejects.toBeInstanceOf(WebScanPausedError);
        await expect(
          store.enqueueScheduledScan('scheduler', {
            siteId: randomUUID(),
            scheduledFor: new Date('2026-11-02T04:00:00.000Z'),
          }),
        ).rejects.toBeInstanceOf(WebScanPausedError);

        // With the kill switch off there is still no site to scan.
        await store.updateSettings('admin-1', { paused: false });
        await expect(
          store.enqueueManualScan('admin-1', {
            siteId: randomUUID(),
            idempotencyKey: 'gate-empty-manual-unpaused',
          }),
        ).rejects.toBeInstanceOf(WebScanNotFoundError);

        // Nothing was written: no request, no site, no schedule and no scan audit row.
        const counts = await context.pool.query(`
          SELECT
            (SELECT count(*) FROM web_scans) AS scans,
            (SELECT count(*) FROM web_scan_sites) AS sites,
            (SELECT count(*) FROM web_scan_sites WHERE schedule->>'enabled' = 'true') AS enabled_schedules,
            (SELECT count(*) FROM web_scan_audit WHERE action LIKE 'scan.%') AS scan_audit
        `);
        expect(counts.rows[0]).toMatchObject({
          scans: '0',
          sites: '0',
          enabled_schedules: '0',
          scan_audit: '0',
        });
      } finally {
        await context.close();
      }
    });

    it('reads the kill switch live from the database on every connection', async () => {
      const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
      const other = await openIndependentConnection(context.connectionString);
      try {
        const store = storeOf(context);
        await store.updateSettings('admin-1', { paused: false });

        // The second session registers a site and queues a scan.
        const site = await registeredSite(other.store, 'gate-live.example.com');
        const first = await other.store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'gate-live-1',
        });
        expect(first.replayed).toBe(false);

        // The first session turns the kill switch on.
        await store.updateSettings('admin-1', { paused: true });

        // The second session never cached the switch, so it refuses the next request.
        await expect(
          other.store.enqueueManualScan('admin-1', {
            siteId: site.id,
            idempotencyKey: 'gate-live-2',
          }),
        ).rejects.toBeInstanceOf(WebScanPausedError);

        // The scan that was queued before the switch is still the only one.
        expect(await other.store.listScans(site.id)).toHaveLength(1);
      } finally {
        await other.close();
        await context.close();
      }
    });

    it('keeps a queued intent after the process that wrote it is gone', async () => {
      const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);

      let siteId: string | undefined;
      let scanId: string | undefined;
      const writer = await openIndependentConnection(context.connectionString);
      try {
        await writer.store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(writer.store, 'gate-durable.example.com');
        siteId = site.id;
        const queued = await writer.store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'gate-durable',
        });
        scanId = queued.scan.id;
        expect(queued.scan.status).toBe('queued');
        // The intent waits for its dispatcher. It is not published by the store.
        expect(queued.scan.outboxState).toBe('pending');
      } finally {
        // The writing process is gone: its session is closed.
        await writer.close();
      }

      const reader = await openIndependentConnection(context.connectionString);
      try {
        if (siteId === undefined || scanId === undefined) {
          throw new Error('The writing session did not queue the intent');
        }
        const scans = await reader.store.listScans(siteId);
        expect(scans).toHaveLength(1);
        expect(scans[0]?.id).toBe(scanId);
        expect(scans[0]?.status).toBe('queued');
        expect(scans[0]?.outboxState).toBe('pending');
        expect(scans[0]?.idempotencyKey).toBe('gate-durable');
      } finally {
        await reader.close();
        await context.close();
      }
    });

    it('never occupies the review queue with a scan intent', async () => {
      await clearRedis(INTEGRATION_REDIS_URL);
      const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
      const queue = new BullMqReviewQueue({ redisUrl: INTEGRATION_REDIS_URL });
      try {
        const store = storeOf(context);
        await store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(store, 'gate-capacity.example.com');
        const queued = await store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'gate-capacity',
        });

        // The review queue holds nothing: the scanner does not consume its capacity.
        expect(await queue.queue.getWaitingCount()).toBe(0);
        expect(await queue.queue.getJobCounts()).toMatchObject({
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
        });
        expect(await queue.queue.getJob('gate-capacity')).toBeUndefined();

        // The intent is durable in PostgreSQL and still waits for its dispatcher.
        const scan = await store.getScan(queued.scan.id);
        expect(scan?.status).toBe('queued');
        expect(scan?.outboxState).toBe('pending');
      } finally {
        await queue.close();
        await context.close();
        await clearRedis(INTEGRATION_REDIS_URL);
      }
    });

    it('keeps the review queue working while a scan intent waits', async () => {
      await clearRedis(INTEGRATION_REDIS_URL);
      const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
      const queue = new BullMqReviewQueue({ redisUrl: INTEGRATION_REDIS_URL });
      let worker: Worker<ReviewJob> | null = null;
      try {
        const store = storeOf(context);
        await store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(store, 'gate-independent.example.com');
        const queued = await store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'gate-independent',
        });

        // A review job is queued on the shared review queue.
        const job: ReviewJob = {
          deliveryId: 'gate-review-1',
          installationId: 4242,
          repoFullName: 'org/repo-gate',
          pullNumber: 7,
          headSha: 'head-sha-gate',
          baseSha: 'base-sha-gate',
        };
        await queue.enqueue(job);
        expect(await queue.queue.getJob('gate-review-1')).not.toBeNull();

        // A real BullMQ worker receives it, so the review queue never waits behind a scan.
        const received: ReviewJob[] = [];
        let resolveDone: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        worker = new Worker<ReviewJob>(
          'reviews',
          async (bullJob) => {
            received.push(bullJob.data);
            resolveDone();
          },
          { connection: createQueueConnection(INTEGRATION_REDIS_URL) },
        );

        await withTimeout(done, 30_000, 'The review job was never delivered');
        expect(received).toHaveLength(1);
        expect(received[0]?.deliveryId).toBe('gate-review-1');

        // The waiting scan intent was not consumed by the review queue.
        const scan = await store.getScan(queued.scan.id);
        expect(scan?.status).toBe('queued');
        expect(scan?.outboxState).toBe('pending');
      } finally {
        if (worker) {
          await worker.close();
        }
        await queue.close();
        await context.close();
        await clearRedis(INTEGRATION_REDIS_URL);
      }
    });

    it('publishes a scan on its own queue and leaves the review queue alone', async () => {
      await clearRedis(INTEGRATION_REDIS_URL);
      const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
      const reviewQueue = new BullMqReviewQueue({ redisUrl: INTEGRATION_REDIS_URL });
      const scanQueue = createWebScanQueue({ connection: createQueueConnection(INTEGRATION_REDIS_URL) });
      const raw = createQueueConnection(INTEGRATION_REDIS_URL);
      try {
        await raw.connect();

        // The scanner has its own queue, and the queue runs one scan at a time.
        expect(WEB_SCAN_QUEUE_NAME).not.toBe('reviews');
        await applyGlobalConcurrency(scanQueue);
        const meta = await raw.hgetall(`bull:${WEB_SCAN_QUEUE_NAME}:meta`);
        expect(meta.concurrency).toBe('1');

        // The durable id of the scan is the job id, and a second publish is one job.
        const scanId = randomUUID();
        await publishScanJob(scanQueue, scanId);
        await publishScanJob(scanQueue, scanId);
        expect(await scanQueue.getWaitingCount()).toBe(1);
        expect(await scanQueue.getJob(scanJobId(scanId))).not.toBeUndefined();

        // The review queue never sees the scan.
        expect(await reviewQueue.queue.getWaitingCount()).toBe(0);
        expect(await reviewQueue.queue.getJobCounts()).toMatchObject({
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
        });
      } finally {
        await scanQueue.close();
        await reviewQueue.close();
        await raw.quit();
        await context.close();
        await clearRedis(INTEGRATION_REDIS_URL);
      }
    });

    it('never stores a schedule that the scheduler cannot evaluate', async () => {
      // The biweekly frequency needs an anchor date. The store normalizes the rule it
      // is given and writes the anchor with it, so the saved rule is always evaluable
      // and the scheduler never has to guess which occurrence comes first.
      const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
      try {
        const store = storeOf(context);
        await store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(store, 'gate-anchor.example.com');
        await store.updateSite('admin-1', site.id, {
          schedule: { frequency: 'biweekly', weekday: 5, hour: 4, minute: 0, enabled: true },
        });

        const stored = await store.getSite(site.id);
        const rule = stored?.schedule;
        expect(rule).not.toBeNull();
        expect(rule?.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(() =>
          nextScheduledRun(rule as WebScanSchedule, new Date('2026-11-06T01:00:00.000Z')),
        ).not.toThrow();
      } finally {
        await context.close();
      }
    });
  });
}

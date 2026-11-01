import { describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import { acquireScanLease } from '../../src/webscan/lease.js';
import { scanJobId, WEB_SCAN_JOB_NAME } from '../../src/webscan/queue.js';
import { startWebScanRuntime } from '../../src/webscan/runtime.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import {
  advisoryLockHolders,
  countAuditRows,
  countScans,
  createFixtureTransport,
  createRecoveryConnection,
  createRecoveryFixture,
  createRecoveryQueue,
  fixtureScript,
  readOutboxState,
  readScanRow,
  RECOVERY_MASTER_KEY,
  RECOVERY_PLATFORM_ADMINS,
  startRecoveryChild,
  until,
  type FixtureTransport,
} from './web-scan-recovery.fixtures.js';
import { hasIntegrationEnv, INTEGRATION_REDIS_URL } from './test-helper.js';

/**
 * The crash and recovery proof of the outbox and of the lease.
 *
 * Every case runs against the dedicated containers of this wave: the Postgres on the port
 * 55460 and the Redis on the port 56385. The queue, the store, the dispatcher and the lease
 * are the production ones.
 *
 * The transport of the scanner is the only thing that is replaced: the test file mocks the
 * factory of the app, so no request of the proof leaves the machine.
 */

const transportHolder = vi.hoisted(
  () => ({ current: null }) as { current: FixtureTransport | null },
);

vi.mock('../../src/webscan/worker-defaults.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/webscan/worker-defaults.js')>();
  return {
    ...actual,
    defaultFetchFactory: (_options: { hostname: string; contact: string; maxResponseBytes: number }) => {
      const transport = transportHolder.current;
      if (transport === null) {
        throw new Error('the proof installed no fixture transport');
      }
      return transport.fetch;
    },
  };
});

/** Removes every job of the scanner queue, so a case starts from an empty queue. */
async function resetScannerQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}

describe.skipIf(!hasIntegrationEnv)(
  'the crash and the recovery of the outbox and of the lease on real Postgres and Redis',
  () => {
    it(
      'refuses the lease in a second process while the first process holds it',
      async () => {
        const fixture = await createRecoveryFixture();
        const holder = startRecoveryChild(fixtureScript('recovery-lease-holder.mjs'), [
          'holder',
          fixture.connectionString,
        ]);
        let contender: ReturnType<typeof startRecoveryChild> | undefined;
        try {
          // The first process took the lease with the production lease function.
          await holder.waitForLine('locked');
          // The evidence that the lock is really held: the backend of the holder holds the
          // advisory lock of the scanner.
          const holders = await advisoryLockHolders(fixture.context.pool);
          expect(holders).toHaveLength(1);

          // The second process asked for the same lease and the production lease refused
          // it, because the lock of the first process is still held.
          contender = startRecoveryChild(fixtureScript('recovery-lease-holder.mjs'), [
            'contender',
            fixture.connectionString,
          ]);
          const line = await contender.waitForLine('unavailable');
          expect(line).toContain('lease_unavailable');
          await contender.waitForExit();
          expect(contender.exitCode).toBe(3);

          // The lock is still held by the first process alone.
          expect(await advisoryLockHolders(fixture.context.pool)).toHaveLength(1);
        } finally {
          await contender?.stop();
          await holder.stop();
          await fixture.context.close();
        }
      },
      60_000,
    );

    it(
      'gives the lease to the second process after the first process died',
      async () => {
        const fixture = await createRecoveryFixture();
        const holder = startRecoveryChild(fixtureScript('recovery-lease-holder.mjs'), [
          'holder',
          fixture.connectionString,
        ]);
        try {
          await holder.waitForLine('locked');
          expect(await advisoryLockHolders(fixture.context.pool)).toHaveLength(1);

          // The first process is killed. Its session of Postgres ends with it, so the server
          // releases the advisory lock by itself.
          await holder.stop();

          // The second process waits for the lock and takes it.
          const contender = startRecoveryChild(fixtureScript('recovery-lease-holder.mjs'), [
            'contender',
            fixture.connectionString,
            '20000',
          ]);
          try {
            const line = await contender.waitForLine('locked', 30_000);
            expect(line).toBe('locked');
            expect(await advisoryLockHolders(fixture.context.pool)).toHaveLength(1);
          } finally {
            await contender.stop();
          }

          // The control: the lock is free again, so the production lease of this process
          // takes it and releases it without a leak.
          const lease = await acquireScanLease({ pool: fixture.context.pool });
          expect(lease.isAlive()).toBe(true);
          await lease.release();
          expect(await advisoryLockHolders(fixture.context.pool)).toHaveLength(0);
        } finally {
          await holder.stop();
          await fixture.context.close();
        }
      },
      90_000,
    );

    it(
      'publishes the committed intent once under the durable scan id after a restart',
      async () => {
        const fixture = await createRecoveryFixture();
        const queue = createRecoveryQueue();
        try {
          await resetScannerQueue(queue);

          // The intent is committed to the database and nothing is published yet.
          const scan = await readScanRow(fixture.context.pool, fixture.scanId);
          expect(scan?.status).toBe('queued');
          expect(await readOutboxState(fixture.context.pool, fixture.scanId)).toBe('pending');
          expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.outbox')).toBe(0);
          expect(await queue.getJob(scanJobId(fixture.scanId))).toBeUndefined();

          // The dispatcher of a new process: the restart of the worker that owns the outbox.
          const dispatcher = startRecoveryChild(fixtureScript('recovery-dispatcher.mjs'), [
            'publish',
            fixture.connectionString,
            INTEGRATION_REDIS_URL,
          ]);
          // The new process reads the committed records in its own session.
          expect(await dispatcher.waitForLine('pending 1')).toBe('pending 1');
          expect(await dispatcher.waitForLine('published 1')).toBe('published 1');
          await dispatcher.waitForExit();
          expect(dispatcher.exitCode).toBe(0);

          // The job carries the durable id of the scan.
          const job = await queue.getJob(scanJobId(fixture.scanId));
          expect(job).not.toBeNull();
          expect(job?.name).toBe(WEB_SCAN_JOB_NAME);
          expect(job?.data.scanId).toBe(fixture.scanId);

          // The acknowledgement is in the database now, and it happened once.
          expect(await readOutboxState(fixture.context.pool, fixture.scanId)).toBe('published');
          expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.outbox')).toBe(1);

          // No intent was lost and none was duplicated.
          expect(await countScans(fixture.context.pool, fixture.siteId)).toBe(1);

          // A second pass of the dispatcher publishes nothing new: the publication of the
          // same scan id is one job.
          const again = startRecoveryChild(fixtureScript('recovery-dispatcher.mjs'), [
            'publish',
            fixture.connectionString,
            INTEGRATION_REDIS_URL,
          ]);
          expect(await again.waitForLine('published 0')).toBe('published 0');
          await again.waitForExit();
          expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.outbox')).toBe(1);
          expect(await countScans(fixture.context.pool, fixture.siteId)).toBe(1);
          const counts = await queue.getJobCounts();
          expect((counts.waiting ?? 0) + (counts.active ?? 0)).toBe(1);
        } finally {
          await queue.close();
          await fixture.context.close();
        }
      },
      90_000,
    );

    it(
      'publishes the job that was not acknowledged again under the same id and runs the scan once',
      async () => {
        const fixture = await createRecoveryFixture();
        const queue = createRecoveryQueue();
        const transport = createFixtureTransport();
        transportHolder.current = transport;
        try {
          await resetScannerQueue(queue);

          // The dispatcher publishes the job and dies in the moment of the acknowledgement.
          const dispatcher = startRecoveryChild(fixtureScript('recovery-dispatcher.mjs'), [
            'crash-before-ack',
            fixture.connectionString,
            INTEGRATION_REDIS_URL,
          ]);
          await dispatcher.waitForLine('pre-ack');
          await dispatcher.waitForExit();

          // The boundary: the job is in Redis, the database does not know it.
          const job = await queue.getJob(scanJobId(fixture.scanId));
          expect(job).not.toBeNull();
          expect(job?.data.scanId).toBe(fixture.scanId);
          expect(await readOutboxState(fixture.context.pool, fixture.scanId)).toBe('pending');
          expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.outbox')).toBe(0);

          // The restart: the runtime of the app publishes the intent again and runs it.
          const runtime = await startWebScanRuntime({
            db: fixture.context.db,
            pool: fixture.context.pool,
            vault: new PurposeScopedVault({ masterKey: RECOVERY_MASTER_KEY }),
            platformAdmins: RECOVERY_PLATFORM_ADMINS,
            connection: createRecoveryConnection(),
          });
          try {
            const finished = await until(async () => {
              const row = await readScanRow(fixture.context.pool, fixture.scanId);
              return row?.status === 'completed';
            }, 60_000);
            expect(finished).toBe(true);

            // The intent was acknowledged once, under the same durable id.
            expect(await readOutboxState(fixture.context.pool, fixture.scanId)).toBe('published');
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.outbox')).toBe(1);

            // The scan ran exactly once: one claim, one outcome, one intent.
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.start')).toBe(1);
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.complete')).toBe(1);
            expect(await countScans(fixture.context.pool, fixture.siteId)).toBe(1);

            // The transport saw the requests of one run and no more. The scope of the site
            // allows no crawl link and the settings enable no check that sends a request,
            // so one run is exactly one request.
            expect(transport.requests).toHaveLength(1);
            expect(transport.requests[0]?.url).toBe('https://127.0.0.1/');

            // There is one job for the scan, not two. The tick of the runtime is a job of
            // its own kind, so only the jobs of the scan are counted here.
            const completed = await queue.getJobs(['completed']);
            const scanJobs = completed.filter((job) => job.name === WEB_SCAN_JOB_NAME);
            expect(scanJobs).toHaveLength(1);
            expect(scanJobs[0]?.id).toBe(scanJobId(fixture.scanId));
            expect(scanJobs[0]?.data.scanId).toBe(fixture.scanId);
          } finally {
            await runtime.close();
            transportHolder.current = null;
          }
        } finally {
          await queue.close();
          await fixture.context.close();
        }
      },
      120_000,
    );
  },
);

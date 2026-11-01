/* global process, URL */
import { Worker } from 'bullmq';
import pg from 'pg';

/**
 * A worker process that claims a scan and then dies.
 *
 * The process does three things:
 *
 * 1. It marks the scan as running with a stale heartbeat, the way a worker that took
 *    the scan and then vanished leaves it behind.
 * 2. It takes the real BullMQ job lock of the scan, so the parent sees the lock of a
 *    live worker in Redis.
 * 3. It holds the job until it is killed. The lock of BullMQ expires on its own, so
 *    the key of the lock is gone once the process is gone: that is the state a crashed
 *    worker leaves behind.
 *
 * The process prints `locked` on the standard output when it holds the job.
 *
 * The usage is:
 *
 *   node crashed-worker.mjs <databaseUrl> <redisUrl> <scanId> <attemptId>
 */

const [, , databaseUrl, redisUrl, scanId, attemptId] = process.argv;

if (
  databaseUrl === undefined ||
  redisUrl === undefined ||
  scanId === undefined ||
  attemptId === undefined
) {
  process.stderr.write('crashed-worker: the arguments are missing\n');
  process.exit(2);
}

const parsed = new URL(redisUrl);

// The heartbeat is stale on purpose: the attempt of a worker that died is exactly the
// attempt the reconciliation has to find.
const pool = new pg.Pool({ connectionString: databaseUrl });
await pool.query(
  `UPDATE web_scans
      SET status = 'running', attempt_id = $1, heartbeat_at = $2, started_at = $2
    WHERE id = $3 AND status = 'queued'`,
  [attemptId, new Date(Date.now() - 10 * 60 * 1000), scanId],
);
await pool.end();

const worker = new Worker(
  'web-scan',
  async () => {
    // The job is held until the process is killed.
    await new Promise(() => {});
  },
  {
    connection: {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
    concurrency: 1,
    // A short lock, so the test does not have to wait for the default of thirty
    // seconds to see the key of the lock disappear.
    lockDuration: 1_000,
    stalledInterval: 1_000,
  },
);

worker.on('active', () => {
  process.stdout.write('locked\n');
});

worker.on('error', () => {
  // The worker of a process that is about to be killed may report the closed
  // connection. It changes nothing about the state of the lock.
});

await new Promise(() => {});

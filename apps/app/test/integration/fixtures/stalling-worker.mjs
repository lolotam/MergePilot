/* global process, URL */
import { Worker } from 'bullmq';

/**
 * A worker process whose lock of the job expires.
 *
 * The process takes the job and then blocks its own event loop, so the lock of the job
 * is not renewed. The lock of BullMQ expires on its own, and the stalled checker of the
 * queue moves the job back to the wait list. The worker of another process sees the
 * stall, which is the moment it learns that it no longer owns the job.
 *
 * The usage is:
 *
 *   node stalling-worker.mjs <redisUrl> <queueName>
 */

const [, , redisUrl, queueName] = process.argv;

if (redisUrl === undefined || queueName === undefined) {
  process.stderr.write('stalling-worker: the arguments are missing\n');
  process.exit(2);
}

const parsed = new URL(redisUrl);

const worker = new Worker(
  queueName,
  async () => {
    // The event loop is blocked for longer than the lock of the job lives, so the
    // renewal of the lock never runs.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  },
  {
    connection: {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
    concurrency: 1,
    lockDuration: 1_000,
    stalledInterval: 1_000,
  },
);

worker.on('active', () => {
  process.stdout.write('holding\n');
});

worker.on('error', () => {
  // The worker of a process that is about to be killed may report the closed
  // connection. It changes nothing about the state of the lock.
});

await new Promise(() => {});

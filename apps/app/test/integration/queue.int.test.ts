import { describe, expect, it } from 'vitest';
import { Worker } from 'bullmq';
import type { ReviewJob } from '../../src/core/types.js';
import { BullMqReviewQueue, createQueueConnection } from '../../src/queue/bullmq-queue.js';
import {
  clearRedis,
  hasIntegrationEnv,
  INTEGRATION_REDIS_URL,
} from './test-helper.js';

describe.skipIf(!hasIntegrationEnv)('queue integration on real Redis', () => {
  it('enqueues twice with the same deliveryId yielding one idempotent job, received by a real BullMQ worker', async () => {
    await clearRedis(INTEGRATION_REDIS_URL);

    const queue = new BullMqReviewQueue({ redisUrl: INTEGRATION_REDIS_URL });

    let worker: Worker<ReviewJob> | null = null;
    try {
      const job: ReviewJob = {
        deliveryId: 'del-queue-idempotent-42',
        installationId: 888,
        repoFullName: 'org/repo-queue',
        pullNumber: 10,
        headSha: 'head-sha-123',
        baseSha: 'base-sha-456',
      };

      // Enqueue twice with the exact same deliveryId
      await queue.enqueue(job);
      await queue.enqueue(job);

      // Verify only one job exists in Redis under that ID
      const redisJob = await queue.queue.getJob('del-queue-idempotent-42');
      expect(redisJob).not.toBeNull();
      expect(redisJob?.id).toBe('del-queue-idempotent-42');

      const waitingCount = await queue.queue.getWaitingCount();
      expect(waitingCount).toBe(1);

      // Real BullMQ Worker receives the single job
      const receivedJobs: ReviewJob[] = [];
      let resolveDone: () => void;
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      worker = new Worker<ReviewJob>(
        'reviews',
        async (bullJob) => {
          receivedJobs.push(bullJob.data);
          resolveDone();
        },
        { connection: createQueueConnection(INTEGRATION_REDIS_URL) },
      );

      await donePromise;

      expect(receivedJobs).toHaveLength(1);
      expect(receivedJobs[0]?.deliveryId).toBe('del-queue-idempotent-42');
      expect(receivedJobs[0]?.installationId).toBe(888);
      expect(receivedJobs[0]?.repoFullName).toBe('org/repo-queue');
      expect(receivedJobs[0]?.pullNumber).toBe(10);
    } finally {
      if (worker) {
        await worker.close();
      }
      await queue.close();
      await clearRedis(INTEGRATION_REDIS_URL);
    }
  });
});

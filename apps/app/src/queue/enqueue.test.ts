import { describe, expect, it } from 'vitest';
import { createRetryJobId, enqueueReviewJob } from './enqueue.js';
import type { ReviewJob, ReviewQueue } from '../core/types.js';

describe('queue enqueue helper', () => {
  it('creates unique retry job IDs starting with retry-', () => {
    const id1 = createRetryJobId();
    const id2 = createRetryJobId();

    expect(id1).toMatch(/^retry-[0-9a-f-]{36}$/);
    expect(id2).toMatch(/^retry-[0-9a-f-]{36}$/);
    expect(id1).not.toBe(id2);
  });

  it('enqueues a job into the queue', async () => {
    const enqueued: ReviewJob[] = [];
    const mockQueue: ReviewQueue = {
      async enqueue(job: ReviewJob) {
        enqueued.push(job);
      },
    };

    const job: ReviewJob = {
      deliveryId: createRetryJobId(),
      installationId: 101,
      repoFullName: 'org/repo',
      pullNumber: 42,
      headSha: 'head-sha-123',
      baseSha: 'base-sha-456',
    };

    await enqueueReviewJob(mockQueue, job);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toEqual(job);
  });
});

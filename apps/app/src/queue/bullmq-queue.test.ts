import { describe, expect, it, vi } from 'vitest';
import type { CommandJob, ReviewJob } from '../core/types.js';
import { BullMqReviewQueue, createQueueConnection } from './bullmq-queue.js';
import type { Queue } from 'bullmq';

describe('createQueueConnection', () => {
  it('creates a Redis client configured with maxRetriesPerRequest = null', () => {
    const redis = createQueueConnection('redis://localhost:6379');
    expect(redis.options.maxRetriesPerRequest).toBeNull();
    redis.disconnect();
  });
});

describe('BullMqReviewQueue', () => {
  const sampleJob: ReviewJob = {
    deliveryId: 'del-123',
    installationId: 456,
    repoFullName: 'org/repo',
    pullNumber: 10,
    headSha: 'head123',
    baseSha: 'base456',
  };

  it('enqueues job with deliveryId as jobId, 3 attempts, exponential backoff, remove completed after 1000', async () => {
    const addMock = vi.fn().mockResolvedValue({ id: sampleJob.deliveryId });
    const fakeQueue = {
      name: 'reviews',
      add: addMock,
    } as unknown as Queue<ReviewJob>;

    const queueWrapper = new BullMqReviewQueue({ queue: fakeQueue });
    await queueWrapper.enqueue(sampleJob);

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith('review', sampleJob, {
      jobId: 'del-123',
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: 1000,
    });
  });

  it.each([
    { kind: 'pause_command' as const, command: 'pause' as const, name: 'pause-command' },
    { kind: 'review_command' as const, command: 'review' as const, name: 'review-command' },
  ])('enqueues a $kind under its own job name, keyed by cmd-<deliveryId>', async ({ kind, command, name }) => {
    const addMock = vi.fn().mockResolvedValue({ id: 'cmd-d-1' });
    const fakeQueue = { name: 'reviews', add: addMock } as unknown as Queue<ReviewJob>;
    const job: CommandJob = {
      kind, command, deliveryId: 'd-1', installationId: 456, repoFullName: 'org/repo', pullNumber: 10, commenterLogin: 'alice', language: 'en',
    } as CommandJob;

    await new BullMqReviewQueue({ queue: fakeQueue }).enqueueCommand(job);

    expect(addMock).toHaveBeenCalledWith(name, job, expect.objectContaining({ jobId: 'cmd-d-1', attempts: 3 }));
  });

  it('ready probe checks waitUntilReady resolution', async () => {
    const waitUntilReadyMock = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = {
      name: 'reviews',
      waitUntilReady: waitUntilReadyMock,
    } as unknown as Queue<ReviewJob>;

    const queueWrapper = new BullMqReviewQueue({ queue: fakeQueue });
    const isReady = await queueWrapper.ready();
    expect(isReady).toBe(true);
    expect(waitUntilReadyMock).toHaveBeenCalled();
  });

  it('ready probe returns false if waitUntilReady rejects', async () => {
    const waitUntilReadyMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    const fakeQueue = {
      name: 'reviews',
      waitUntilReady: waitUntilReadyMock,
    } as unknown as Queue<ReviewJob>;

    const queueWrapper = new BullMqReviewQueue({ queue: fakeQueue });
    const isReady = await queueWrapper.ready();
    expect(isReady).toBe(false);
  });

  it('close closes the underlying queue', async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = {
      name: 'reviews',
      close: closeMock,
    } as unknown as Queue<ReviewJob>;

    const queueWrapper = new BullMqReviewQueue({ queue: fakeQueue });
    await queueWrapper.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

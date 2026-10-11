import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { ReviewJob, ReviewQueue } from '../core/types.js';

/**
 * Creates an ioredis client configured for BullMQ (maxRetriesPerRequest: null).
 */
export function createQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
}

export interface BullMqReviewQueueOptions {
  connection?: Redis | ConnectionOptions;
  redisUrl?: string;
  queue?: Queue<ReviewJob>;
}

export class BullMqReviewQueue implements ReviewQueue {
  readonly queue: Queue<ReviewJob>;

  constructor(options?: string | BullMqReviewQueueOptions) {
    if (typeof options === 'string') {
      this.queue = new Queue<ReviewJob>('reviews', {
        connection: createQueueConnection(options),
      });
    } else if (options?.queue) {
      this.queue = options.queue;
    } else if (options?.connection) {
      this.queue = new Queue<ReviewJob>('reviews', {
        connection: options.connection,
      });
    } else if (options?.redisUrl) {
      this.queue = new Queue<ReviewJob>('reviews', {
        connection: createQueueConnection(options.redisUrl),
      });
    } else {
      throw new Error('BullMqReviewQueue requires redisUrl, connection, or queue option');
    }
  }

  async enqueue(job: ReviewJob): Promise<void> {
    await this.queue.add('review', job, {
      jobId: job.deliveryId,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: 1000,
    });
  }

  async ready(): Promise<boolean> {
    try {
      await this.queue.waitUntilReady();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

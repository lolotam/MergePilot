import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { ReviewJob } from '../core/types.js';
import { processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';

export interface ReviewWorkerOptions {
  connection?: ConnectionOptions;
  concurrency?: number;
}

/**
 * Creates a BullMQ worker for the 'reviews' queue with concurrency 2 by default.
 */
export function createReviewWorker(
  deps: ProcessReviewDeps,
  options?: ReviewWorkerOptions,
): Worker<ReviewJob> {
  const concurrency = options?.concurrency ?? 2;
  const connection = options?.connection ?? { host: 'localhost', port: 6379 };

  const worker = new Worker<ReviewJob>(
    'reviews',
    async (job: Job<ReviewJob>) => {
      deps.log?.(`Processing review job ${job.data.deliveryId} for #${job.data.pullNumber}`);
      await processReviewJob(job.data, deps);
    },
    {
      concurrency,
      connection,
    },
  );

  return worker;
}

export interface ProcessSignalTarget {
  on(event: string, handler: () => void | Promise<void>): void;
}

/**
 * Attaches graceful shutdown hooks on SIGTERM and SIGINT to stop the worker cleanly.
 */
export function attachShutdownHandlers(
  worker: Worker,
  processTarget: ProcessSignalTarget = process,
): () => Promise<void> {
  let isClosing = false;

  const shutdown = async () => {
    if (isClosing) return;
    isClosing = true;
    try {
      await worker.close();
    } catch {
      // Ignore errors on closing
    }
  };

  processTarget.on('SIGTERM', shutdown);
  processTarget.on('SIGINT', shutdown);

  return shutdown;
}

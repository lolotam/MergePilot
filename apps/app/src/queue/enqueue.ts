import { randomUUID } from 'node:crypto';
import type { ReviewJob, ReviewQueue } from '../core/types.js';

/**
 * Generates a unique delivery ID for a retry run.
 */
export function createRetryJobId(): string {
  return `retry-${randomUUID()}`;
}

/**
 * Enqueues a review job to the queue, reusing the same job structure as webhooks.
 */
export async function enqueueReviewJob(
  queue: ReviewQueue,
  job: ReviewJob,
): Promise<void> {
  await queue.enqueue(job);
}

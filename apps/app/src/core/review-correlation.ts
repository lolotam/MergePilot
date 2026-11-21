import type { ReviewJob } from './types.js';

/** Allowlisted identifiers only; never spread a job into a log record. */
export function reviewCorrelation(job: ReviewJob) {
  return { jobId: job.deliveryId, repo: job.repoFullName, pullNumber: job.pullNumber, headSha: job.headSha };
}

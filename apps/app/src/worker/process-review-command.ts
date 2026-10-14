import { isAuthorizedToControlPause, replyReviewCommandRejected, type ReviewCommandRejection } from '@mergepilot/github';
import { workerLogger } from '../core/logger.js';
import { isPrClosedOrMerged, type PullRequestDetails } from '../core/pull-request-state.js';
import type { ReviewCommandJob } from '../core/types.js';
import { DUPLICATE, processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';
import { guardWritesForWorkspace } from './workspace-guard.js';

/**
 * `reviewed`: the forced review completed. `review_failed` / `review_skipped`: it ran but did not
 * complete (the run row has the detail). `skipped`: the installation is unknown or suspended.
 */
export type ReviewCommandOutcome = 'reviewed' | 'review_failed' | 'review_skipped' | ReviewCommandRejection | 'skipped';

/**
 * Runs a queued `@mergepilot review` request (ADR-0012 amendment): a commenter with write access
 * on an open PR gets a full review of its current head by every active bot, even when the bots
 * already reviewed it or the PR is paused. A refused request gets one short reply saying why;
 * an accepted one gets no reply, because the reviews themselves are the answer.
 */
export async function processReviewCommandJob(job: ReviewCommandJob, deps: ProcessReviewDeps): Promise<ReviewCommandOutcome> {
  const logger = deps.logger ?? workerLogger;
  const base = { jobId: job.deliveryId, repo: job.repoFullName, pullNumber: job.pullNumber, command: job.command };

  const installation = await deps.store.getInstallation(job.installationId);
  if (!installation || installation.suspended) {
    const reason = !installation ? 'unknown installation' : 'suspended installation';
    logger.info({ event: 'job.skipped', ...base, reason }, `Review command ${job.deliveryId} skipped: ${reason}`);
    return 'skipped';
  }

  const [owner, repo] = job.repoFullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFullName: ${job.repoFullName}`);

  const { client: rawClient } = await deps.githubAppFactory(job.installationId);
  const client = guardWritesForWorkspace(rawClient, deps.store, job.installationId, installation.workspaceId);
  const pr = { owner, repo, pull_number: job.pullNumber };
  // A reply that cannot be posted never fails the job: a retry would run the whole command again.
  const replyRejected = async (reason: ReviewCommandRejection): Promise<void> => {
    try {
      await replyReviewCommandRejected(client, { ...pr, reason, language: job.language });
    } catch (error) {
      logger.warn({ event: 'review_command.reply_failed', ...base, reason, error: error instanceof Error ? error.name : 'unknown' },
        `Could not post the refusal reply on ${job.repoFullName}#${job.pullNumber}`);
    }
  };
  const reject = async (reason: ReviewCommandRejection): Promise<ReviewCommandOutcome> => {
    await replyRejected(reason);
    logger.info({ event: 'review_command.rejected', ...base, reason, workspace: installation.workspaceId },
      `Review command on ${job.repoFullName}#${job.pullNumber} not run: ${reason}`);
    return reason;
  };

  if (!(await isAuthorizedToControlPause(client, { owner, repo, username: job.commenterLogin }))) return reject('unauthorized');

  const details = (await client.getPullRequest(pr)) as unknown as PullRequestDetails;
  if (isPrClosedOrMerged(details)) return reject('closed');
  const headSha = details.head.sha;
  if (await deps.store.findActiveReviewRun(installation.workspaceId, job.repoFullName, job.pullNumber, headSha)) {
    return reject('running');
  }

  logger.info({ event: 'review_command.accepted', ...base, headSha: headSha.slice(0, 7), workspace: installation.workspaceId },
    `Review requested on ${job.repoFullName}#${job.pullNumber} by a write-access user`);
  const result = await processReviewJob({
    deliveryId: `review-${job.deliveryId}`,
    installationId: job.installationId,
    repoFullName: job.repoFullName,
    pullNumber: job.pullNumber,
    headSha,
    baseSha: details.base?.sha ?? '',
    force: true,
  }, deps);
  // A push can claim the head between the check above and the run's creation (the store's
  // unique active run per head decides): the request lost that race and is answered as such.
  const raceLost = result.status === 'skipped' && result.detail === DUPLICATE;
  const outcome: ReviewCommandOutcome = raceLost
    ? 'running'
    : result.status === 'completed' ? 'reviewed' : result.status === 'failed' ? 'review_failed' : 'review_skipped';
  logger[result.status === 'failed' ? 'warn' : 'info'](
    { event: 'review_command.finished', ...base, outcome, status: result.status, detail: result.detail ?? null, workspace: installation.workspaceId },
    `Review requested on ${job.repoFullName}#${job.pullNumber} finished: ${result.status}`,
  );
  if (raceLost) await replyRejected('running');
  return outcome;
}

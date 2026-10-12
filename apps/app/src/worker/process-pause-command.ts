import { executePauseCommand } from '@mergepilot/github';
import { workerLogger } from '../core/logger.js';
import type { PauseCommandJob } from '../core/types.js';
import type { ProcessReviewDeps } from './types.js';
import { guardWritesForWorkspace } from './workspace-guard.js';

export type PauseCommandOutcome = 'paused' | 'active' | 'unauthorized' | 'label_error' | 'skipped';

/**
 * Applies a queued `@mergepilot pause|resume` command (ADR-0012) through the installation client:
 * checks the commenter has write access (collaborator permission API), then sets or removes the
 * `mergepilot:paused` label and replies once. An unauthorized commenter gets a polite reply and
 * the PR state is left unchanged. No review run is created and no model is called.
 */
export async function processPauseCommandJob(
  job: PauseCommandJob,
  deps: Pick<ProcessReviewDeps, 'store' | 'githubAppFactory' | 'logger' | 'log'>,
): Promise<PauseCommandOutcome> {
  const logger = deps.logger ?? workerLogger;
  const base = { jobId: job.deliveryId, repo: job.repoFullName, pullNumber: job.pullNumber, command: job.command };

  const installation = await deps.store.getInstallation(job.installationId);
  if (!installation || installation.suspended) {
    const reason = !installation ? 'unknown installation' : 'suspended installation';
    logger.info({ event: 'job.skipped', ...base, reason }, `Pause command ${job.deliveryId} skipped: ${reason}`);
    return 'skipped';
  }

  const [owner, repo] = job.repoFullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFullName: ${job.repoFullName}`);

  const { client: rawClient, publisherLogin } = await deps.githubAppFactory(job.installationId);
  const client = guardWritesForWorkspace(rawClient, deps.store, job.installationId, installation.workspaceId);

  const result = await executePauseCommand(client, {
    owner,
    repo,
    pull_number: job.pullNumber,
    command: job.command,
    username: job.commenterLogin,
    publisherLogin,
    language: job.language,
  });

  const outcome: PauseCommandOutcome = result.success ? result.state : result.reason;
  deps.log?.(`Pause command ${job.deliveryId} (${job.command}) on ${job.repoFullName}#${job.pullNumber}: ${outcome}`);
  // label_error: the App could not remove the label (permissions); the PR stays paused.
  const level = outcome === 'label_error' ? 'warn' : 'info';
  logger[level](
    { event: 'pause_command.applied', ...base, outcome, workspace: installation.workspaceId },
    `Pause command ${job.command} on ${job.repoFullName}#${job.pullNumber}: ${outcome}`,
  );
  return outcome;
}

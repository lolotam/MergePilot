import { runAudit } from './audit.js';
import type { ActionDeps } from './deps.js';
import { runPullRequestReview } from './pull-request.js';

export type { ActionDeps } from './deps.js';

/** Routes the triggering event: pull requests get a review, manual or scheduled runs an audit. */
export async function run(deps?: ActionDeps): Promise<void> {
  const env = deps?.env ?? process.env;
  const log = deps?.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const eventName = env.GITHUB_EVENT_NAME;

  if (eventName === 'pull_request') return runPullRequestReview(deps);
  if (eventName === 'workflow_dispatch' || eventName === 'schedule') return runAudit(deps);
  log(`MergePilot skipped: event "${eventName ?? ''}" is not pull_request`);
}

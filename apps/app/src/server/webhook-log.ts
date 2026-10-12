import type { WebhookResult } from '../webhooks/handle.js';

export function firstHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Non-secret identifiers from a webhook payload: action, repository and PR number. */
export function webhookPayloadFields(payload: unknown): {
  action: string | null;
  repo: string | null;
  pr: number | null;
} {
  const obj = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const repository = obj.repository as { full_name?: unknown } | undefined;
  const pullRequest = obj.pull_request as { number?: unknown } | undefined;
  // An issue_comment on a PR carries the PR number as `issue.number` (with `issue.pull_request` set).
  const issue = obj.issue as { number?: unknown; pull_request?: unknown } | undefined;
  const prNumber =
    typeof pullRequest?.number === 'number'
      ? pullRequest.number
      : issue?.pull_request && typeof issue.number === 'number'
        ? issue.number
        : null;
  return {
    action: typeof obj.action === 'string' ? obj.action : null,
    repo: typeof repository?.full_name === 'string' ? repository.full_name : null,
    pr: prNumber,
  };
}

const INSTALLATION_EVENTS = {
  installation_created: 'installation.created',
  installation_deleted: 'installation.unlinked',
  installation_suspended: 'installation.suspended',
  installation_unsuspended: 'installation.unsuspended',
} as const;

/**
 * The outcome of one webhook delivery plus its domain detail, so a single log line
 * describes it (no separate domain-event line for the same delivery).
 */
export function webhookOutcomeFields(result: WebhookResult): Record<string, string | number> {
  switch (result.status) {
    case 'enqueued':
      return { outcome: 'queued' };
    case 'command_queued':
      return { outcome: 'queued', command: result.job.command };
    case 'duplicate':
      return { outcome: 'duplicate' };
    case 'ignored':
      return { outcome: 'ignored', ...(result.reason ? { reason: result.reason } : {}) };
    default:
      return {
        outcome: 'processed',
        domainEvent: INSTALLATION_EVENTS[result.status],
        installationId: result.installationId,
      };
  }
}

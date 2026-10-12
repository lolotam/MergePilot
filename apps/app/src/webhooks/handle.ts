import { z } from 'zod';
import type { AppStore, ReviewJob, ReviewQueue } from '../core/types.js';
import { handleIssueCommentEvent, type CommandQueuedResult } from './issue-comment.js';

export interface WebhookContext {
  event: string;
  deliveryId: string;
  payload: unknown;
}

export interface WebhookDeps {
  store: AppStore;
  queue: ReviewQueue;
  log?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug?(msg: string, ...args: unknown[]): void;
  };
}

export type WebhookResult =
  | { status: 'duplicate' }
  | { status: 'ignored'; reason?: string }
  | { status: 'installation_created'; installationId: number }
  | { status: 'installation_deleted'; installationId: number }
  | { status: 'installation_suspended'; installationId: number }
  | { status: 'installation_unsuspended'; installationId: number }
  | { status: 'enqueued'; job: ReviewJob }
  | CommandQueuedResult;

const InstallationCreatedPayloadSchema = z.object({
  action: z.literal('created'),
  installation: z.object({
    id: z.number(),
    account: z.object({
      login: z.string().min(1),
      type: z.enum(['User', 'Organization']).default('User'),
    }),
    repository_selection: z.enum(['all', 'selected']).default('all'),
    suspended_at: z.string().nullable().optional(),
  }),
});

const InstallationActionPayloadSchema = z.object({
  action: z.enum(['deleted', 'suspend', 'unsuspend']),
  installation: z.object({
    id: z.number(),
  }),
});

const PullRequestPayloadSchema = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened', 'ready_for_review']),
  installation: z.object({
    id: z.number(),
  }),
  repository: z.object({
    full_name: z.string().min(1),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    draft: z.boolean().default(false),
    head: z.object({
      sha: z.string().min(1),
    }),
    base: z.object({
      sha: z.string().min(1),
    }),
  }),
});

export async function handleWebhook(
  { event, deliveryId, payload }: WebhookContext,
  { store, queue, log }: WebhookDeps,
): Promise<WebhookResult> {
  const isNew = await store.recordDelivery(deliveryId, event);
  if (!isNew) {
    log?.info(`Duplicate delivery ${deliveryId} for event ${event}`);
    return { status: 'duplicate' };
  }

  if (event === 'installation') {
    return handleInstallationEvent(payload, store, log);
  }

  if (event === 'pull_request') {
    return handlePullRequestEvent(deliveryId, payload, store, queue, log);
  }

  if (event === 'issue_comment') {
    const result = await handleIssueCommentEvent(deliveryId, payload, store, queue);
    if (result.status === 'command_queued') {
      log?.info(`Queued @mergepilot ${result.job.command} for PR #${result.job.pullNumber} (${result.job.repoFullName})`);
    }
    return result;
  }

  return { status: 'ignored', reason: `unhandled_event_${event}` };
}

async function handleInstallationEvent(
  payload: unknown,
  store: AppStore,
  log?: WebhookDeps['log'],
): Promise<WebhookResult> {
  const createdParsed = InstallationCreatedPayloadSchema.safeParse(payload);
  if (createdParsed.success) {
    const { installation } = createdParsed.data;
    await store.upsertPendingInstallation({
      id: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repositorySelection: installation.repository_selection,
      suspended: Boolean(installation.suspended_at),
    });
    log?.info(`Upserted pending installation ${installation.id}`);
    return { status: 'installation_created', installationId: installation.id };
  }

  const actionParsed = InstallationActionPayloadSchema.safeParse(payload);
  if (actionParsed.success) {
    const { action, installation } = actionParsed.data;
    if (action === 'deleted') {
      await store.deleteInstallation(installation.id);
      log?.info(`Deleted installation ${installation.id}`);
      return { status: 'installation_deleted', installationId: installation.id };
    }
    if (action === 'suspend') {
      await store.setInstallationSuspended(installation.id, true);
      log?.info(`Suspended installation ${installation.id}`);
      return { status: 'installation_suspended', installationId: installation.id };
    }
    if (action === 'unsuspend') {
      await store.setInstallationSuspended(installation.id, false);
      log?.info(`Unsuspended installation ${installation.id}`);
      return { status: 'installation_unsuspended', installationId: installation.id };
    }
  }

  return { status: 'ignored', reason: 'unhandled_installation_payload' };
}

async function handlePullRequestEvent(
  deliveryId: string,
  payload: unknown,
  store: AppStore,
  queue: ReviewQueue,
  log?: WebhookDeps['log'],
): Promise<WebhookResult> {
  const parsed = PullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: 'ignored', reason: 'invalid_pull_request_payload' };
  }

  const { pull_request: pr, installation, repository } = parsed.data;

  if (pr.draft) {
    log?.info(`Skipping draft PR #${pr.number} in ${repository.full_name}`);
    return { status: 'ignored', reason: 'draft_pr' };
  }

  const storedInstallation = await store.getInstallation(installation.id);
  if (!storedInstallation) {
    log?.info(`Installation ${installation.id} is unknown or pending (no linked workspace)`);
    return { status: 'ignored', reason: 'installation_not_found_or_pending' };
  }

  if (storedInstallation.suspended) {
    log?.info(`Installation ${installation.id} is suspended`);
    return { status: 'ignored', reason: 'installation_suspended' };
  }

  const job: ReviewJob = {
    deliveryId,
    installationId: installation.id,
    repoFullName: repository.full_name,
    pullNumber: pr.number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
  };

  await queue.enqueue(job);
  log?.info(`Enqueued review job for PR #${pr.number} (${repository.full_name})`);

  return { status: 'enqueued', job };
}

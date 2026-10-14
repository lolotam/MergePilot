import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../auth/guard.js';
import { isPrClosedOrMerged, type PullRequestDetails } from '../core/pull-request-state.js';
import { ActiveRunExistsError } from '../core/types.js';
import { createRetryJobId, enqueueReviewJob } from '../queue/enqueue.js';
import { createGitHubAppFactory } from '../worker/github-app-factory.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import type {
  RetryFailedDryRunResponse,
  RetryFailedResponse,
  RetryItem,
  SkippedRetryItem,
} from './contract.js';
import { sendError } from './helpers.js';
import { parseRetryFailedBody } from './runs-query.js';
import type { DashboardApiDeps } from './routes.js';

/** What a retry starts from: a failed or skipped run's PR. */
interface RetrySource {
  installationId: number;
  repoFullName: string;
  pullNumber: number;
}

type SkipReason =
  | 'invalid_repo'
  | 'installation_suspended'
  | 'pr_not_found'
  | 'pr_closed'
  | 'already_running'
  | 'enqueue_failed';

type Outcome<T> = ({ ok: true } & T) | { ok: false; reason: SkipReason };

const RETRY_FAILED_WINDOW_MS = 60_000;
const RETRY_FAILED_CAP = 25;

// Rate limit for "retry all failed": one real call per workspace per minute. It lives in this
// process's memory only, so each API process (replica) enforces its own minute and a restart
// clears it. Dry runs neither check nor record it.
const retryFailedTimestamps = new Map<string, number>();

export function isRetryFailedRateLimited(workspaceId: string, now = Date.now()): boolean {
  const last = retryFailedTimestamps.get(workspaceId);
  return last !== undefined && now - last < RETRY_FAILED_WINDOW_MS;
}

export function recordRetryFailedCall(workspaceId: string, now = Date.now()): void {
  for (const [id, at] of retryFailedTimestamps) {
    if (now - at >= RETRY_FAILED_WINDOW_MS) retryFailedTimestamps.delete(id);
  }
  retryFailedTimestamps.set(workspaceId, now);
}

export function resetRetryRateLimits(): void {
  retryFailedTimestamps.clear();
}

/** Checks the PR can be retried now and returns its current head and base. Read-only. */
async function checkRetryable(
  deps: DashboardApiDeps,
  getFactory: () => GitHubAppClientFactory,
  workspaceId: string,
  src: RetrySource,
): Promise<Outcome<{ headSha: string; baseSha: string }>> {
  const [owner, repo] = src.repoFullName.split('/');
  if (!owner || !repo) return { ok: false, reason: 'invalid_repo' };

  const installation = await deps.store.getInstallation(src.installationId);
  if (!installation || installation.suspended) {
    return { ok: false, reason: 'installation_suspended' };
  }

  let pr: unknown;
  try {
    const { client } = await getFactory()(src.installationId);
    pr = await client.getPullRequest({ owner, repo, pull_number: src.pullNumber });
  } catch {
    return { ok: false, reason: 'pr_not_found' };
  }
  if (isPrClosedOrMerged(pr)) return { ok: false, reason: 'pr_closed' };

  const details = pr as PullRequestDetails;
  const headSha = details.head.sha;
  const active = await deps.store.findActiveReviewRun(
    workspaceId,
    src.repoFullName,
    src.pullNumber,
    headSha,
  );
  if (active) return { ok: false, reason: 'already_running' };
  return { ok: true, headSha, baseSha: details.base?.sha ?? '' };
}

/**
 * Creates the queued run and enqueues its job. The store's unique index makes "no active run for
 * this head" and the insert one atomic step: a race loser gets ActiveRunExistsError, reported as
 * `already_running`.
 */
async function queueRetry(
  deps: DashboardApiDeps,
  workspaceId: string,
  src: RetrySource,
  headSha: string,
  baseSha: string,
): Promise<Outcome<{ runId: string }>> {
  const jobId = createRetryJobId();
  let runId: string;
  try {
    const run = await deps.store.createReviewRun({
      workspaceId,
      installationId: src.installationId,
      repoFullName: src.repoFullName,
      pullNumber: src.pullNumber,
      headSha,
      status: 'queued',
      costUsd: null,
      detail: null,
      jobId,
    });
    runId = run.id;
  } catch (error) {
    if (error instanceof ActiveRunExistsError) return { ok: false, reason: 'already_running' };
    throw error;
  }

  try {
    if (!deps.queue) throw new Error('queue unavailable');
    await enqueueReviewJob(deps.queue, {
      deliveryId: jobId,
      installationId: src.installationId,
      repoFullName: src.repoFullName,
      pullNumber: src.pullNumber,
      headSha,
      baseSha,
    });
  } catch {
    // Without a job the run would sit in `queued` until the stale sweep; close it now.
    await deps.store.finishReviewRun(workspaceId, runId, {
      status: 'failed',
      costUsd: null,
      detail: 'enqueue_failed',
    });
    return { ok: false, reason: 'enqueue_failed' };
  }
  return { ok: true, runId };
}

const SINGLE_RETRY_ERRORS: Record<SkipReason, { status: number; code: string; message: string }> = {
  invalid_repo: { status: 400, code: 'invalid_repo', message: 'Invalid repository name' },
  installation_suspended: {
    status: 409,
    code: 'installation_suspended',
    message: 'Installation is suspended or not found',
  },
  pr_not_found: {
    status: 404,
    code: 'pr_not_found',
    message: 'Could not fetch pull request from GitHub',
  },
  pr_closed: { status: 409, code: 'pr_closed', message: 'Pull request is closed or merged' },
  already_running: {
    status: 409,
    code: 'already_running',
    message: 'A review run for this commit is already queued or running',
  },
  enqueue_failed: {
    status: 503,
    code: 'queue_unavailable',
    message: 'Could not queue the review, try again',
  },
};

export function registerRunsRetryRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  let factory: GitHubAppClientFactory | undefined = deps.githubAppFactory;
  const getFactory = (): GitHubAppClientFactory => {
    factory ??= createGitHubAppFactory({
      appId: deps.config.github.appId,
      privateKey: deps.config.github.privateKey,
      appSlug: deps.config.github.appSlug,
    });
    return factory;
  };

  // 1. POST /api/workspaces/:workspaceId/runs/:runId/retry
  app.post(
    '/api/workspaces/:workspaceId/runs/:runId/retry',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, runId } = request.params as { workspaceId: string; runId: string };

      const run = await deps.store.getReviewRun(workspaceId, runId);
      if (!run) return sendError(reply, 404, 'not_found', 'Review run not found');
      if (run.status !== 'failed' && run.status !== 'skipped') {
        return sendError(
          reply,
          409,
          'invalid_status',
          'Only failed or skipped review runs can be retried',
        );
      }

      const check = await checkRetryable(deps, getFactory, workspaceId, run);
      const queued = check.ok
        ? await queueRetry(deps, workspaceId, run, check.headSha, check.baseSha)
        : check;
      if (!queued.ok) {
        const error = SINGLE_RETRY_ERRORS[queued.reason];
        return sendError(reply, error.status, error.code, error.message);
      }
      request.log.info(
        {
          event: 'runs.retry',
          workspaceId,
          runId: queued.runId,
          sourceRunId: runId,
          retriedCount: 1,
        },
        'Review run retried',
      );
      return reply.status(202).send({ runId: queued.runId });
    },
  );

  // 2. POST /api/workspaces/:workspaceId/runs/retry-failed (`dryRun: true` only previews)
  app.post(
    '/api/workspaces/:workspaceId/runs/retry-failed',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };

      // Validate first: an invalid body never counts against the rate limit.
      const parsed = parseRetryFailedBody(request.body);
      if (!parsed.ok) return sendError(reply, 400, 'validation_error', parsed.message);
      const { dryRun, ...filters } = parsed.filters;

      if (!dryRun) {
        const now = deps.now ? deps.now().getTime() : Date.now();
        if (isRetryFailedRateLimited(workspaceId, now)) {
          return sendError(
            reply,
            429,
            'rate_limited',
            'Retry all failed runs is rate limited to once per minute per workspace',
          );
        }
        // Recorded synchronously right after the check, so two concurrent calls cannot both pass.
        recordRetryFailedCall(workspaceId, now);
      }

      const candidates = await deps.store.listLatestFailedRuns(workspaceId, {
        ...filters,
        limit: RETRY_FAILED_CAP,
      });

      const items: RetryItem[] = [];
      const skipped: SkippedRetryItem[] = [];
      for (const candidate of candidates) {
        const item: RetryItem = { repo: candidate.repoFullName, pullNumber: candidate.pullNumber };
        const check = await checkRetryable(deps, getFactory, workspaceId, candidate);
        if (!check.ok) {
          skipped.push({ ...item, reason: check.reason });
          continue;
        }
        if (dryRun) {
          items.push(item);
          continue;
        }
        const queued = await queueRetry(deps, workspaceId, candidate, check.headSha, check.baseSha);
        if (queued.ok) items.push(item);
        else skipped.push({ ...item, reason: queued.reason });
      }

      if (dryRun) {
        request.log.info(
          {
            event: 'runs.retry_all',
            workspaceId,
            dryRun: true,
            wouldQueueCount: items.length,
            skippedCount: skipped.length,
          },
          'Previewed retry of failed review runs',
        );
        const preview: RetryFailedDryRunResponse = { wouldQueue: items.length, items, skipped };
        return reply.status(200).send(preview);
      }
      request.log.info(
        {
          event: 'runs.retry_all',
          workspaceId,
          dryRun: false,
          queuedCount: items.length,
          skippedCount: skipped.length,
        },
        'Retried failed review runs',
      );
      const result: RetryFailedResponse = { queued: items.length, skipped };
      return reply.status(200).send(result);
    },
  );
}

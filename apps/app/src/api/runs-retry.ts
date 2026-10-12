import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../auth/guard.js';
import { createRetryJobId, enqueueReviewJob } from '../queue/enqueue.js';
import { createGitHubAppFactory } from '../worker/main.js';
import { RetryFailedBodySchema } from './contract.js';
import { sendError } from './helpers.js';
import type { DashboardApiDeps } from './routes.js';

interface PullRequestDetails {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  head: { sha: string };
  base?: { sha: string };
}

const retryFailedTimestamps = new Map<string, number>();

export function checkRetryFailedRateLimit(workspaceId: string, now = Date.now()): boolean {
  const last = retryFailedTimestamps.get(workspaceId);
  if (last !== undefined && now - last < 60_000) {
    return false;
  }
  retryFailedTimestamps.set(workspaceId, now);
  return true;
}

export function resetRetryRateLimits(): void {
  retryFailedTimestamps.clear();
}

export function isPrClosedOrMerged(pr: unknown): boolean {
  const details = pr as PullRequestDetails;
  return (
    details.state === 'closed' ||
    Boolean(details.merged) ||
    Boolean(details.merged_at)
  );
}

function parseDateParam(val?: string, endOfDay = false): Date | undefined {
  if (!val) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return endOfDay
      ? new Date(`${val}T23:59:59.999Z`)
      : new Date(`${val}T00:00:00.000Z`);
  }
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function registerRunsRetryRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  const getAppFactory = () =>
    deps.githubAppFactory ??
    createGitHubAppFactory({
      appId: deps.config.github.appId,
      privateKey: deps.config.github.privateKey,
      appSlug: deps.config.github.appSlug,
    });

  // 1. POST /api/workspaces/:workspaceId/runs/:runId/retry
  app.post(
    '/api/workspaces/:workspaceId/runs/:runId/retry',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, runId } = request.params as {
        workspaceId: string;
        runId: string;
      };

      const run = await deps.store.getReviewRun(workspaceId, runId);
      if (!run) {
        return sendError(reply, 404, 'not_found', 'Review run not found');
      }

      if (run.status !== 'failed' && run.status !== 'skipped') {
        return sendError(
          reply,
          409,
          'invalid_status',
          'Only failed or skipped review runs can be retried',
        );
      }

      const installation = await deps.store.getInstallation(run.installationId);
      if (!installation || installation.suspended) {
        return sendError(
          reply,
          409,
          'installation_suspended',
          'Installation is suspended or not found',
        );
      }

      const [owner, repo] = run.repoFullName.split('/');
      if (!owner || !repo) {
        return sendError(reply, 400, 'invalid_repo', 'Invalid repository name');
      }

      let pr: unknown;
      try {
        const factory = getAppFactory();
        const { client } = await factory(run.installationId);
        pr = await client.getPullRequest({ owner, repo, pull_number: run.pullNumber });
      } catch {
        return sendError(reply, 404, 'pr_not_found', 'Could not fetch pull request from GitHub');
      }

      if (isPrClosedOrMerged(pr)) {
        return sendError(reply, 409, 'pr_closed', 'Pull request is closed or merged');
      }

      const prDetails = pr as PullRequestDetails;
      const currentHeadSha = prDetails.head.sha;
      const currentBaseSha = prDetails.base?.sha ?? '';

      const activeRun = await deps.store.findActiveReviewRun(
        workspaceId,
        run.repoFullName,
        run.pullNumber,
        currentHeadSha,
      );
      if (activeRun) {
        return sendError(
          reply,
          409,
          'already_running',
          'A review run for this commit is already queued or running',
        );
      }

      const jobId = createRetryJobId();
      const newRun = await deps.store.createReviewRun({
        workspaceId,
        installationId: run.installationId,
        repoFullName: run.repoFullName,
        pullNumber: run.pullNumber,
        headSha: currentHeadSha,
        status: 'queued',
        costUsd: null,
        detail: null,
        jobId,
      });

      try {
        if (!deps.queue) throw new Error('queue unavailable');
        await enqueueReviewJob(deps.queue, {
          deliveryId: jobId,
          installationId: run.installationId,
          repoFullName: run.repoFullName,
          pullNumber: run.pullNumber,
          headSha: currentHeadSha,
          baseSha: currentBaseSha,
        });
      } catch {
        // Without a job the run would sit in `queued` until the stale sweep; close it now.
        await deps.store.finishReviewRun(workspaceId, newRun.id, {
          status: 'failed',
          costUsd: null,
          detail: 'enqueue_failed',
        });
        return sendError(reply, 503, 'queue_unavailable', 'Could not queue the review, try again');
      }

      return reply.status(202).send({ runId: newRun.id });
    },
  );

  // 2. POST /api/workspaces/:workspaceId/runs/retry-failed
  app.post(
    '/api/workspaces/:workspaceId/runs/retry-failed',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };

      const now = deps.now ? deps.now().getTime() : Date.now();
      if (!checkRetryFailedRateLimit(workspaceId, now)) {
        return sendError(
          reply,
          429,
          'rate_limited',
          'Retry all failed runs is rate limited to once per minute per workspace',
        );
      }

      const parsed = RetryFailedBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, 'validation_error', 'Invalid request body');
      }

      const body = parsed.data ?? {};
      const from = parseDateParam(body.from, false);
      const to = parseDateParam(body.to, true);

      const candidates = await deps.store.listLatestFailedRuns(workspaceId, {
        repo: body.repo,
        from,
        to,
        limit: 25,
      });

      const skipped: Array<{ repo: string; pullNumber: number; reason: string }> = [];
      let queued = 0;

      const factory = getAppFactory();

      for (const candidate of candidates) {
        const [owner, repo] = candidate.repoFullName.split('/');
        if (!owner || !repo) {
          skipped.push({
            repo: candidate.repoFullName,
            pullNumber: candidate.pullNumber,
            reason: 'invalid_repo',
          });
          continue;
        }

        const installation = await deps.store.getInstallation(candidate.installationId);
        if (!installation || installation.suspended) {
          skipped.push({
            repo: candidate.repoFullName,
            pullNumber: candidate.pullNumber,
            reason: 'installation_suspended',
          });
          continue;
        }

        let pr: unknown;
        try {
          const { client } = await factory(candidate.installationId);
          pr = await client.getPullRequest({ owner, repo, pull_number: candidate.pullNumber });
        } catch {
          skipped.push({
            repo: candidate.repoFullName,
            pullNumber: candidate.pullNumber,
            reason: 'pr_not_found',
          });
          continue;
        }

        if (isPrClosedOrMerged(pr)) {
          skipped.push({
            repo: candidate.repoFullName,
            pullNumber: candidate.pullNumber,
            reason: 'pr_closed',
          });
          continue;
        }

        const prDetails = pr as PullRequestDetails;
        const currentHeadSha = prDetails.head.sha;
        const currentBaseSha = prDetails.base?.sha ?? '';

        const activeRun = await deps.store.findActiveReviewRun(
          workspaceId,
          candidate.repoFullName,
          candidate.pullNumber,
          currentHeadSha,
        );
        if (activeRun) {
          skipped.push({
            repo: candidate.repoFullName,
            pullNumber: candidate.pullNumber,
            reason: 'already_running',
          });
          continue;
        }

        const jobId = createRetryJobId();
        const newRun = await deps.store.createReviewRun({
          workspaceId,
          installationId: candidate.installationId,
          repoFullName: candidate.repoFullName,
          pullNumber: candidate.pullNumber,
          headSha: currentHeadSha,
          status: 'queued',
          costUsd: null,
          detail: null,
          jobId,
        });

        try {
          if (!deps.queue) throw new Error('queue unavailable');
          await enqueueReviewJob(deps.queue, {
            deliveryId: jobId,
            installationId: candidate.installationId,
            repoFullName: candidate.repoFullName,
            pullNumber: candidate.pullNumber,
            headSha: currentHeadSha,
            baseSha: currentBaseSha,
          });
        } catch {
          await deps.store.finishReviewRun(workspaceId, newRun.id, {
            status: 'failed',
            costUsd: null,
            detail: 'enqueue_failed',
          });
          skipped.push({
            repo: candidate.repoFullName,
            pullNumber: candidate.pullNumber,
            reason: 'enqueue_failed',
          });
          continue;
        }

        queued++;
      }

      return reply.status(200).send({ queued, skipped });
    },
  );
}

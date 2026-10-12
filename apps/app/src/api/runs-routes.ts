import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../auth/guard.js';
import { computeSeverityCounts } from './contract.js';
import { sendError } from './helpers.js';
import { parseRunsListQuery } from './runs-query.js';
import type { DashboardApiDeps } from './routes.js';

export function registerRunsRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  // 1. GET /api/workspaces/:workspaceId/runs/repos (distinct repo names)
  app.get(
    '/api/workspaces/:workspaceId/runs/repos',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const repos = await deps.store.listReviewRunRepos(workspaceId);
      return reply.status(200).send({ repos });
    },
  );

  // 2. GET /api/workspaces/:workspaceId/runs (list with filtering, sorting, pagination)
  app.get(
    '/api/workspaces/:workspaceId/runs',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const parsed = parseRunsListQuery(request.query);
      if (!parsed.ok) {
        return sendError(reply, 400, parsed.code, parsed.message);
      }
      const result = await deps.store.listReviewRuns(workspaceId, parsed.options);

      const runs = 'runs' in result ? result.runs : result;
      const total = 'total' in result ? result.total : runs.length;

      return reply.status(200).send({
        runs: runs.map((r) => ({
          id: r.id,
          repoFullName: r.repoFullName,
          pullNumber: r.pullNumber,
          headSha: r.headSha,
          status: r.status,
          costUsd: r.costUsd,
          detail: r.detail,
          createdAt:
            r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
          finishedAt: r.finishedAt
            ? r.finishedAt instanceof Date
              ? r.finishedAt.toISOString()
              : new Date(r.finishedAt).toISOString()
            : null,
          provider: r.provider ?? null,
          model: r.model ?? null,
          effort: r.effort ?? null,
          fallbackFrom: r.fallbackFrom ?? null,
          findingsCount: r.findingsCount ?? null,
          severityCounts: r.result ? computeSeverityCounts(r.result.findings, r.result.outOfDiff) : null,
          reviewUrl: r.reviewUrl ?? null,
        })),
        total,
      });
    },
  );

  // 3. GET /api/workspaces/:workspaceId/runs/:runId (detail with result payload)
  app.get(
    '/api/workspaces/:workspaceId/runs/:runId',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, runId } = request.params as { workspaceId: string; runId: string };
      const r = await deps.store.getReviewRun(workspaceId, runId);
      if (!r) {
        return sendError(reply, 404, 'not_found', 'Review run not found');
      }

      const severityCounts = r.result
        ? computeSeverityCounts(r.result.findings, r.result.outOfDiff)
        : null;

      return reply.status(200).send({
        run: {
          id: r.id,
          repoFullName: r.repoFullName,
          pullNumber: r.pullNumber,
          headSha: r.headSha,
          status: r.status,
          costUsd: r.costUsd,
          detail: r.detail,
          createdAt:
            r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
          finishedAt: r.finishedAt
            ? r.finishedAt instanceof Date
              ? r.finishedAt.toISOString()
              : new Date(r.finishedAt).toISOString()
            : null,
          provider: r.provider ?? null,
          model: r.model ?? null,
          effort: r.effort ?? null,
          fallbackFrom: r.fallbackFrom ?? null,
          findingsCount: r.findingsCount ?? null,
          severityCounts,
          reviewUrl: r.reviewUrl ?? null,
          result: r.result ?? null,
        },
      });
    },
  );
}

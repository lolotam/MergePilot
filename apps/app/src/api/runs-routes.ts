import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../auth/guard.js';
import { sendError } from './helpers.js';
import { toRunDto, toRunGroupDto } from './run-dto.js';
import { registerRunsDeleteRoutes } from './runs-delete.js';
import { parseRunsListQuery } from './runs-query.js';
import { registerRunsRetryRoutes } from './runs-retry.js';
import type { DashboardApiDeps } from './routes.js';

export function registerRunsRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  registerRunsRetryRoutes(app, deps);
  registerRunsDeleteRoutes(app, deps);

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
      if (parsed.groupBy === 'pr') {
        const grouped = await deps.store.listReviewRunGroups(workspaceId, parsed.options);
        return reply.status(200).send({
          groups: grouped.groups.map(toRunGroupDto),
          total: grouped.total,
          totalRuns: grouped.totalRuns,
        });
      }
      const result = await deps.store.listReviewRuns(workspaceId, parsed.options);

      const runs = 'runs' in result ? result.runs : result;
      const total = 'total' in result ? result.total : runs.length;

      return reply.status(200).send({ runs: runs.map(toRunDto), total });
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

      return reply.status(200).send({ run: { ...toRunDto(r), result: r.result ?? null } });
    },
  );
}

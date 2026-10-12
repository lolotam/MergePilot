import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../auth/guard.js';
import type { ReviewRunStatus } from '../core/types.js';
import { computeSeverityCounts } from './contract.js';
import { sendError } from './helpers.js';
import type { DashboardApiDeps } from './routes.js';

export const ALLOWED_SORT_KEYS = [
  'createdAt',
  'repo',
  'pullNumber',
  'status',
  'provider',
  'model',
  'findingsCount',
  'costUsd',
  'duration',
] as const;

export type SortKey = (typeof ALLOWED_SORT_KEYS)[number];

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
      const query = request.query as {
        limit?: string;
        offset?: string;
        repo?: string | string[];
        status?: string | string[];
        from?: string;
        to?: string;
        provider?: string;
        q?: string;
        sort?: string;
        dir?: string;
      };

      let limit = 50;
      if (query?.limit !== undefined) {
        const parsed = parseInt(query.limit, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          limit = Math.min(parsed, 100);
        }
      }

      let offset = 0;
      if (query?.offset !== undefined) {
        const parsed = parseInt(query.offset, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          offset = parsed;
        }
      }

      let repoList: string[] | undefined;
      if (query?.repo) {
        repoList = Array.isArray(query.repo) ? query.repo : [query.repo];
      }

      let statusList: ReviewRunStatus[] | undefined;
      if (query?.status) {
        statusList = (Array.isArray(query.status) ? query.status : [query.status]) as ReviewRunStatus[];
      }

      let fromDate: Date | undefined;
      if (query?.from) {
        const d = new Date(query.from);
        if (!Number.isNaN(d.getTime())) fromDate = d;
      }

      let toDate: Date | undefined;
      if (query?.to) {
        const d = new Date(query.to);
        if (!Number.isNaN(d.getTime())) toDate = d;
      }

      let sortKey: SortKey | undefined;
      if (query?.sort) {
        if (!ALLOWED_SORT_KEYS.includes(query.sort as SortKey)) {
          return sendError(
            reply,
            400,
            'invalid_sort',
            `Sort key must be one of: ${ALLOWED_SORT_KEYS.join(', ')}`,
          );
        }
        sortKey = query.sort as SortKey;
      }

      const dir = query?.dir === 'asc' ? 'asc' : 'desc';

      const result = await deps.store.listReviewRuns(workspaceId, {
        limit,
        offset,
        repo: repoList,
        status: statusList,
        from: fromDate,
        to: toDate,
        provider: query?.provider,
        q: query?.q,
        sort: sortKey,
        dir,
      });

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

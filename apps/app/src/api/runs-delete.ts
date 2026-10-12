import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth/guard.js';
import {
  RunCountMismatchError,
  RunsNotFoundError,
  type DeleteRunsTarget,
  type RunFilters,
} from '../core/run-types.js';
import { WorkspaceDeletedError } from '../core/types.js';
import { DeleteRunsRequestSchema, type DeleteRunsFilters } from './contract.js';
import { sendError } from './helpers.js';
import type { DashboardApiDeps } from './routes.js';
import { toDate } from './runs-query.js';

type ParsedTarget = { ok: true; target: DeleteRunsTarget } | { ok: false; message: string };

function toRunFilters(f: DeleteRunsFilters): RunFilters | null {
  const from = f.from ? toDate(f.from, 'start') : undefined;
  const to = f.to ? toDate(f.to, 'end') : undefined;
  if (from && to && from.getTime() > to.getTime()) return null;
  return {
    repo: f.repo && f.repo.length > 0 ? f.repo : undefined,
    status: f.status && f.status.length > 0 ? f.status : undefined,
    from,
    to,
    q: f.q,
  };
}

/** Validates the body; failures name the bad fields but never echo their values. */
export function parseDeleteRunsBody(body: unknown): ParsedTarget {
  const parsed = DeleteRunsRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'body')))];
    return { ok: false, message: `Invalid field(s): ${fields.join(', ')}; send either ids or filters with confirmCount` };
  }
  if ('ids' in parsed.data) return { ok: true, target: { ids: parsed.data.ids } };
  const filters = toRunFilters(parsed.data.filters);
  if (!filters) return { ok: false, message: '`from` must not be after `to`' };
  return { ok: true, target: { filters, expectedCount: parsed.data.confirmCount } };
}

export function registerRunsDeleteRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  // POST /api/workspaces/:workspaceId/runs/delete (admin/owner): bulk delete finished runs.
  app.post(
    '/api/workspaces/:workspaceId/runs/delete',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const parsed = parseDeleteRunsBody(request.body);
      if (!parsed.ok) return sendError(reply, 400, 'validation_error', parsed.message);
      const { target } = parsed;
      const mode = 'ids' in target ? 'ids' : 'filters';
      const requested = 'ids' in target ? new Set(target.ids).size : target.expectedCount;

      let deleted: number;
      try {
        deleted = await deps.store.deleteReviewRuns(workspaceId, target);
      } catch (err) {
        if (err instanceof RunsNotFoundError) {
          return sendError(reply, 404, 'not_found', 'One or more review runs were not found');
        }
        if (err instanceof RunCountMismatchError) {
          return reply.status(409).send({
            error: {
              code: 'count_mismatch',
              message: 'The filters now match a different number of runs; refresh and try again',
              actual: err.actual,
            },
          });
        }
        if (err instanceof WorkspaceDeletedError) {
          return sendError(reply, 404, 'not_found', 'Workspace not found');
        }
        throw err;
      }

      // Counts only: never the ids or the filter values.
      request.log.info(
        { event: 'runs.bulk_delete', workspaceId, mode, requested, deleted },
        `Deleted ${deleted} review run(s)`,
      );
      return reply.status(200).send({ deleted });
    },
  );
}

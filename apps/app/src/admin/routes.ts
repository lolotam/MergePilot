import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/auth.js';
import type { AppConfig } from '../core/config.js';
import type { AppStore } from '../core/types.js';
import { sendError } from '../api/helpers.js';
import { deleteUser, deleteWorkspace, type ActionResult } from './actions.js';
import { requirePlatformAdmin } from './guard.js';
import { registerMaintenanceRoutes } from './routes-maintenance.js';
import {
  ADMIN_DEFAULT_PAGE_SIZE,
  clampPagination,
  getOverview,
  getRuns,
  type AdminDb,
  type Pagination,
} from './queries.js';
import { getUsers } from './queries-users.js';
import { getWorkspaces } from './queries-workspaces.js';

export interface AdminApiDeps {
  auth: Auth;
  db: AdminDb;
  config: AppConfig;
  /** For the maintenance routes (run retention); without it they report 503 / no last run. */
  store?: AppStore | undefined;
}

const PageQuerySchema = z.object({
  limit: z.coerce.number().int().catch(ADMIN_DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().catch(0),
});

/** Optional free-text search term; blank or oversized values are ignored. */
const SearchTermSchema = z.string().trim().min(1).max(200).optional().catch(undefined);

const UsersQuerySchema = PageQuerySchema.extend({ q: SearchTermSchema });

const RunsQuerySchema = PageQuerySchema.extend({
  workspaceId: SearchTermSchema,
  workspaceQuery: SearchTermSchema,
});

/** Bad values fall back to defaults; clampPagination then enforces 1 ≤ limit ≤ 100, offset ≥ 0. */
function parsePage(request: FastifyRequest): Pagination {
  return clampPagination(PageQuerySchema.parse(request.query ?? {}));
}

function sendAction(reply: FastifyReply, result: ActionResult): FastifyReply {
  if (!result.ok) {
    if (result.status === 409) {
      const { code, message, workspaces } = result;
      return reply.status(409).send({ error: { code, message, workspaces } });
    }
    return sendError(reply, result.status, result.code, result.message);
  }
  return reply.status(204).send();
}

/** Platform operator API. Every route answers 404 unless the caller is a platform admin. */
export function registerAdminApi(app: FastifyInstance, deps: AdminApiDeps): void {
  const guard = requirePlatformAdmin(deps.config, deps.auth);
  const { db } = deps;

  app.get('/api/admin/overview', { preHandler: [guard] }, async (_request, reply) => {
    return reply.status(200).send(await getOverview(db));
  });

  app.get('/api/admin/users', { preHandler: [guard] }, async (request, reply) => {
    const query = UsersQuerySchema.parse(request.query ?? {});
    const page = clampPagination(query);
    return reply.status(200).send(await getUsers(db, { ...page, q: query.q }));
  });

  app.get('/api/admin/workspaces', { preHandler: [guard] }, async (request, reply) => {
    return reply.status(200).send(await getWorkspaces(db, parsePage(request)));
  });

  app.get('/api/admin/runs', { preHandler: [guard] }, async (request, reply) => {
    const query = RunsQuerySchema.parse(request.query ?? {});
    const page = clampPagination(query);
    const result = await getRuns(db, {
      ...page,
      workspaceId: query.workspaceId,
      workspaceQuery: query.workspaceQuery,
    });
    return reply.status(200).send(result);
  });

  app.delete('/api/admin/users/:userId', { preHandler: [guard] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const adminId = request.adminUser?.id;
    if (!adminId) return sendError(reply, 404, 'not_found', 'Not found');
    return sendAction(reply, await deleteUser(db, adminId, userId, request.log));
  });

  app.delete(
    '/api/admin/workspaces/:workspaceId',
    { preHandler: [guard] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const adminId = request.adminUser?.id;
      if (!adminId) return sendError(reply, 404, 'not_found', 'Not found');
      return sendAction(reply, await deleteWorkspace(db, adminId, workspaceId, request.log));
    },
  );

  registerMaintenanceRoutes(app, guard, deps.store);
}

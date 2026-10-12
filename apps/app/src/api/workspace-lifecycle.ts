import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getOrgAdapter } from 'better-auth/plugins/organization';
import { requireRole } from '../auth/guard.js';
import type { DashboardApiDeps } from './routes.js';
import { sendError } from './helpers.js';
import { RenameWorkspaceRequestSchema, DeleteWorkspaceRequestSchema } from './contract.js';

export function registerWorkspaceLifecycleRoutes(
  app: FastifyInstance,
  deps: DashboardApiDeps,
): void {
  // 1. PATCH /api/workspaces/:workspaceId — role admin or owner
  app.patch(
    '/api/workspaces/:workspaceId',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };

      const parsed = RenameWorkspaceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          'validation_error',
          parsed.error.issues[0]?.message ?? 'Name must be between 1 and 60 characters',
        );
      }

      const name = parsed.data.name;

      const authContext = (await deps.auth.$context) as unknown as Parameters<typeof getOrgAdapter>[0];
      const orgAdapter = getOrgAdapter(authContext);

      const existing = await orgAdapter.findOrganizationById(workspaceId);
      if (!existing) {
        return sendError(reply, 404, 'not_found', 'Workspace not found');
      }

      await orgAdapter.updateOrganization(workspaceId, { name });
      request.log.info(
        {
          event: 'workspace.renamed',
          workspaceId,
        },
        'Workspace renamed',
      );

      return reply.status(200).send({ id: workspaceId, name });
    },
  );

  // 2. DELETE /api/workspaces/:workspaceId — role owner only
  app.delete(
    '/api/workspaces/:workspaceId',
    { preHandler: [requireRole('owner', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };

      const authContext = (await deps.auth.$context) as unknown as Parameters<typeof getOrgAdapter>[0];
      const orgAdapter = getOrgAdapter(authContext);

      const existing = await orgAdapter.findOrganizationById(workspaceId);
      if (!existing) {
        return sendError(reply, 404, 'not_found', 'Workspace not found');
      }

      const parsed = DeleteWorkspaceRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.confirmName !== existing.name) {
        return sendError(
          reply,
          400,
          'confirm_mismatch',
          'Confirmation name must match workspace name exactly',
        );
      }

      // Postgres: data and the organization row (members and invitations cascade) go in one
      // transaction, so a failure leaves the workspace fully intact.
      const { organizationDeleted } = await deps.store.deleteWorkspace(workspaceId);
      if (!organizationDeleted) {
        // Local-dev MemoryStore keeps no auth tables; remove the organization through Better Auth.
        await orgAdapter.deleteOrganization(workspaceId);
      }

      request.log.info(
        {
          event: 'workspace.deleted',
          workspaceId,
        },
        'Workspace deleted',
      );

      return reply.status(204).send();
    },
  );
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../auth/guard.js';
import { listUserInstallations, type UserInstallation } from '../auth/github-installations.js';
import { InstallationAlreadyLinkedError } from '../core/types.js';
import {
  sendError,
  getAuthSession,
  getUserGitHubAccount,
  fetchUserGitHubInstallations,
} from './helpers.js';
import type { DashboardApiDeps } from './routes.js';

export function registerInstallationRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  // 1. GET /api/workspaces/:workspaceId/installations
  app.get(
    '/api/workspaces/:workspaceId/installations',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const installations = await deps.store.listInstallations(workspaceId);
      return reply.status(200).send({
        installations: installations.map((i) => ({
          id: i.id,
          accountLogin: i.accountLogin,
          accountType: i.accountType,
          repositorySelection: i.repositorySelection,
          suspended: i.suspended,
        })),
      });
    },
  );

  // 2. POST /api/workspaces/:workspaceId/installations/:installationId/link
  app.post(
    '/api/workspaces/:workspaceId/installations/:installationId/link',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, installationId: rawId } = request.params as {
        workspaceId: string;
        installationId: string;
      };
      if (!/^\d+$/.test(rawId)) {
        return sendError(reply, 400, 'bad_request', 'installationId must be digits');
      }
      const installationId = parseInt(rawId, 10);
      const userId = request.auth?.userId ?? '';

      const githubAccount = await getUserGitHubAccount(deps.auth, userId);
      if (!githubAccount.linked || !githubAccount.accessToken) {
        return sendError(reply, 403, 'forbidden', 'GitHub account is not linked');
      }

      let userInstallations: UserInstallation[];
      try {
        userInstallations = await listUserInstallations(
          githubAccount.accessToken,
          deps.githubFetch ?? globalThis.fetch,
        );
      } catch {
        return sendError(reply, 403, 'forbidden', 'Could not verify user installations on GitHub');
      }

      const fromGitHub = userInstallations.find((i) => i.id === installationId);
      if (!fromGitHub) {
        return sendError(reply, 403, 'forbidden', 'User cannot access this installation');
      }

      const existing = await deps.store.getInstallation(installationId);
      if (!existing) {
        await deps.store.upsertPendingInstallation(fromGitHub);
      }
      if (existing && existing.workspaceId !== workspaceId) {
        return sendError(
          reply,
          409,
          'installation_already_linked',
          'Installation is already linked to another workspace',
        );
      }

      try {
        await deps.store.linkInstallation(installationId, workspaceId);
        request.log.info(
          {
            event: 'installation.linked',
            workspaceId,
            installationId,
          },
          'Installation linked to workspace',
        );
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof InstallationAlreadyLinkedError) {
          return sendError(reply, 409, 'installation_already_linked', 'Installation is already linked to another workspace');
        }
        return sendError(reply, 404, 'not_found', `Installation ${installationId} not found`);
      }
    },
  );

  // 3. GET /api/github/installations
  app.get('/api/github/installations', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await getAuthSession(request, deps.auth);
    if (!session) {
      return sendError(reply, 401, 'unauthorized', 'Not signed in');
    }

    const githubAccount = await getUserGitHubAccount(deps.auth, session.user.id);
    if (!githubAccount.linked || !githubAccount.accessToken) {
      return sendError(reply, 409, 'github_not_linked', 'GitHub account is not linked');
    }

    const rawInsts = await fetchUserGitHubInstallations(
      githubAccount.accessToken,
      deps.githubFetch ?? globalThis.fetch,
    );

    const installations = await Promise.all(
      rawInsts.map(async (inst) => {
        const stored = await deps.store.getInstallation(inst.id);
        return {
          id: inst.id,
          accountLogin: inst.account.login,
          accountType: inst.account.type === 'Organization' ? ('Organization' as const) : ('User' as const),
          repositorySelection: inst.repository_selection === 'all' ? ('all' as const) : ('selected' as const),
          suspended: Boolean(inst.suspended_at),
          linkedWorkspaceId: stored?.workspaceId ?? null,
        };
      }),
    );

    const installUrl = `https://github.com/apps/${deps.config.github.appSlug}/installations/new`;
    return reply.status(200).send({ installations, installUrl });
  });

  // 4. GET /app/installed
  app.get('/app/installed', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { installation_id?: string; setup_action?: string };
    const installationId = query?.installation_id;
    if (!installationId || !/^\d+$/.test(installationId)) {
      return sendError(reply, 400, 'bad_request', 'Invalid installation_id');
    }

    return reply.redirect(`/install?installation_id=${installationId}`, 302);
  });
}

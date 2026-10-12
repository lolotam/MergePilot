import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from '../auth/auth.js';
import { requireRole } from '../auth/guard.js';
import { listUserInstallations, type UserInstallation } from '../auth/github-installations.js';
import type { AppConfig } from '../core/config.js';
import { InstallationAlreadyLinkedError, type ApiProvider, type AppStore } from '../core/types.js';
import type { CredentialService } from '../credentials/service.js';
import { ApiProviderSchema, SettingsSchema, SaveKeyRequestSchema } from './contract.js';
import { validateKey as defaultValidateKey } from './validate-key.js';
import {
  sendError,
  getAuthSession,
  getUserGitHubAccount,
  getUserWorkspaces,
  fetchUserGitHubInstallations,
} from './helpers.js';
import { registerWorkspaceLifecycleRoutes } from './workspace-lifecycle.js';

export interface DashboardApiDeps {
  auth: Auth;
  store: AppStore;
  credentials: CredentialService;
  validateKey?: (provider: ApiProvider, apiKey: string) => Promise<void>;
  githubFetch?: typeof fetch;
  config: AppConfig;
  now?: () => Date;
}

export function registerDashboardApi(
  app: FastifyInstance,
  deps: DashboardApiDeps,
): void {
  const validateKeyFn = deps.validateKey ?? ((p, k) => defaultValidateKey(p, k, deps.githubFetch));

  // 1. GET /api/me
  app.get('/api/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await getAuthSession(request, deps.auth);
    if (!session) {
      return sendError(reply, 401, 'unauthorized', 'Not signed in');
    }

    const githubAccount = await getUserGitHubAccount(deps.auth, session.user.id);
    const workspaces = await getUserWorkspaces(deps.auth, session.user.id);

    return reply.status(200).send({
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? null,
        image: session.user.image ?? null,
        githubLinked: githubAccount.linked,
      },
      workspaces,
    });
  });

  // 2. GET /api/workspaces/:workspaceId/settings
  app.get(
    '/api/workspaces/:workspaceId/settings',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const settings = await deps.store.getSettings(workspaceId);
      return reply.status(200).send({ settings });
    },
  );

  // 3. PUT /api/workspaces/:workspaceId/settings
  app.put(
    '/api/workspaces/:workspaceId/settings',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const parsed = SettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          'validation_error',
          parsed.error.issues[0]?.message ?? 'Invalid settings',
        );
      }

      await deps.store.saveSettings({
        workspaceId,
        provider: parsed.data.provider,
        model: parsed.data.model,
        language: parsed.data.language,
        monthlyBudgetUsd: parsed.data.monthlyBudgetUsd,
      });

      return reply.status(200).send({ settings: parsed.data });
    },
  );

  // 4. GET /api/workspaces/:workspaceId/keys
  app.get(
    '/api/workspaces/:workspaceId/keys',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const keys = await deps.credentials.listKeys(workspaceId);
      const safeKeys = keys.map((k) => ({
        provider: k.provider,
        last4: k.last4,
        createdAt: k.createdAt instanceof Date ? k.createdAt.toISOString() : new Date(k.createdAt).toISOString(),
        createdBy: k.createdBy,
      }));
      return reply.status(200).send({ keys: safeKeys });
    },
  );

  // 5. PUT /api/workspaces/:workspaceId/keys/:provider
  app.put(
    '/api/workspaces/:workspaceId/keys/:provider',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, provider: rawProvider } = request.params as {
        workspaceId: string;
        provider: string;
      };
      const providerParse = ApiProviderSchema.safeParse(rawProvider);
      if (!providerParse.success) {
        return sendError(reply, 400, 'invalid_provider', 'Provider must be anthropic, openai, or gemini');
      }
      const provider = providerParse.data;

      const bodyParse = SaveKeyRequestSchema.safeParse(request.body);
      if (!bodyParse.success) {
        return sendError(
          reply,
          400,
          'validation_error',
          bodyParse.error.issues[0]?.message ?? 'Invalid apiKey',
        );
      }
      const apiKey = bodyParse.data.apiKey.trim();

      try {
        await validateKeyFn(provider, apiKey);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = rawMsg.replaceAll(apiKey, '[REDACTED]');
        return sendError(reply, 422, 'validation_failed', safeMsg);
      }

      const userId = request.auth?.userId ?? '';
      try {
        const saved = await deps.credentials.saveKey({
          workspaceId,
          provider,
          apiKey,
          userId,
        });

        return reply.status(200).send({
          provider: saved.provider,
          last4: saved.last4,
          createdAt: saved.createdAt instanceof Date ? saved.createdAt.toISOString() : new Date(saved.createdAt).toISOString(),
          createdBy: saved.createdBy,
        });
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = rawMsg.replaceAll(apiKey, '[REDACTED]');
        return sendError(reply, 422, 'validation_failed', safeMsg);
      }
    },
  );

  // 6. DELETE /api/workspaces/:workspaceId/keys/:provider
  app.delete(
    '/api/workspaces/:workspaceId/keys/:provider',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, provider: rawProvider } = request.params as {
        workspaceId: string;
        provider: string;
      };
      const providerParse = ApiProviderSchema.safeParse(rawProvider);
      if (!providerParse.success) {
        return sendError(reply, 400, 'invalid_provider', 'Provider must be anthropic, openai, or gemini');
      }

      await deps.credentials.deleteKey(workspaceId, providerParse.data);
      return reply.status(204).send();
    },
  );

  // 7. GET /api/workspaces/:workspaceId/installations
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

  // 8. POST /api/workspaces/:workspaceId/installations/:installationId/link
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
        // The `installation` webhook may never have reached us (e.g. the App was installed
        // before its webhook was configured); GitHub just confirmed it to this user, so record it.
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
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof InstallationAlreadyLinkedError) {
          return sendError(reply, 409, 'installation_already_linked', 'Installation is already linked to another workspace');
        }
        return sendError(reply, 404, 'not_found', `Installation ${installationId} not found`);
      }
    },
  );

  // 9. GET /api/github/installations
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

  // 10. GET /api/workspaces/:workspaceId/runs
  app.get(
    '/api/workspaces/:workspaceId/runs',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const query = request.query as { limit?: string };

      let limit = 50;
      if (query?.limit !== undefined) {
        const parsed = parseInt(query.limit, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          limit = Math.min(parsed, 200);
        }
      }

      const runs = await deps.store.listReviewRuns(workspaceId, limit);
      return reply.status(200).send({
        runs: runs.map((r) => ({
          id: r.id,
          repoFullName: r.repoFullName,
          pullNumber: r.pullNumber,
          headSha: r.headSha,
          status: r.status,
          costUsd: r.costUsd,
          detail: r.detail,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
          finishedAt: r.finishedAt ? (r.finishedAt instanceof Date ? r.finishedAt.toISOString() : new Date(r.finishedAt).toISOString()) : null,
        })),
      });
    },
  );

  // 11. GET /api/workspaces/:workspaceId/usage
  app.get(
    '/api/workspaces/:workspaceId/usage',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const now = deps.now ? deps.now() : new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

      const monthCostUsd = await deps.store.monthCostUsd(workspaceId, monthStart);
      const settings = await deps.store.getSettings(workspaceId);

      return reply.status(200).send({
        monthCostUsd,
        monthlyBudgetUsd: settings?.monthlyBudgetUsd ?? null,
        monthStart: monthStart.toISOString(),
      });
    },
  );

  // 12. GET /app/installed
  app.get('/app/installed', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { installation_id?: string; setup_action?: string };
    const installationId = query?.installation_id;
    if (!installationId || !/^\d+$/.test(installationId)) {
      return sendError(reply, 400, 'bad_request', 'Invalid installation_id');
    }

    return reply.redirect(`/install?installation_id=${installationId}`, 302);
  });

  registerWorkspaceLifecycleRoutes(app, deps);
}

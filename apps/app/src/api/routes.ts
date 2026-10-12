import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from '../auth/auth.js';
import { isUserPlatformAdmin } from '../admin/guard.js';
import { requireRole } from '../auth/guard.js';
import type { AppConfig } from '../core/config.js';
import { assertSafeBaseUrl } from '../core/ssrf.js';
import type { ApiProvider, AppStore, ReviewQueue } from '../core/types.js';
import type { CredentialService } from '../credentials/service.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import { ApiProviderSchema, SettingsSchema, SaveKeyRequestSchema } from './contract.js';
import { validateKey as defaultValidateKey } from './validate-key.js';
import {
  sendError,
  getAuthSession,
  getUserGitHubAccount,
  getUserWorkspaces,
} from './helpers.js';
import { registerInstallationRoutes } from './installation-routes.js';
import { registerProviderRoutes } from './provider-routes.js';
import { registerRunsRoutes } from './runs-routes.js';
import { registerWorkspaceLifecycleRoutes } from './workspace-lifecycle.js';

export interface DashboardApiDeps {
  auth: Auth;
  store: AppStore;
  credentials: CredentialService;
  validateKey?: (provider: ApiProvider, apiKey: string, baseUrl?: string) => Promise<void>;
  githubFetch?: typeof fetch;
  config: AppConfig;
  now?: () => Date;
  queue?: ReviewQueue;
  githubAppFactory?: GitHubAppClientFactory;
}

const toIso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function registerDashboardApi(
  app: FastifyInstance,
  deps: DashboardApiDeps,
): void {
  const validateKeyFn = deps.validateKey ?? ((p, k, b) => defaultValidateKey(p, k, b, deps.githubFetch));

  // 1. GET /api/me
  app.get('/api/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await getAuthSession(request, deps.auth);
    if (!session) {
      return sendError(reply, 401, 'unauthorized', 'Not signed in');
    }

    const githubAccount = await getUserGitHubAccount(deps.auth, session.user.id);
    const workspaces = await getUserWorkspaces(deps.auth, session.user.id);
    const isPlatformAdmin = isUserPlatformAdmin(session.user, deps.config.platformAdmins);

    return reply.status(200).send({
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? null,
        image: session.user.image ?? null,
        githubLinked: githubAccount.linked,
      },
      workspaces,
      isPlatformAdmin,
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

      if (parsed.data.heavyProvider) {
        if (!parsed.data.heavyModel) {
          return sendError(reply, 400, 'validation_error', 'heavyModel is required when heavyProvider is set');
        }
        const cred = await deps.store.getCredential(workspaceId, parsed.data.heavyProvider);
        if (!cred) {
          return sendError(
            reply,
            400,
            'heavy_key_missing',
            `Stored API key required for heavy provider: ${parsed.data.heavyProvider}`,
          );
        }
      }

      for (const entry of parsed.data.fallback ?? []) {
        const cred = await deps.store.getCredential(workspaceId, entry.provider);
        if (!cred) {
          return sendError(
            reply,
            400,
            'fallback_key_missing',
            `Stored API key required for fallback provider: ${entry.provider}`,
          );
        }
      }

      await deps.store.saveSettings({
        workspaceId,
        provider: parsed.data.provider,
        model: parsed.data.model,
        effort: parsed.data.effort ?? null,
        heavyProvider: parsed.data.heavyProvider ?? null,
        heavyModel: parsed.data.heavyModel ?? null,
        heavyEffort: parsed.data.heavyEffort ?? null,
        heavyThresholdLines: parsed.data.heavyThresholdLines ?? null,
        fallback: parsed.data.fallback ?? [],
        minSeverity: parsed.data.minSeverity ?? 'medium',
        language: parsed.data.language,
        monthlyBudgetUsd: parsed.data.monthlyBudgetUsd ?? null,
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
        baseUrl: k.baseUrl ?? null,
        createdAt: toIso(k.createdAt),
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
        return sendError(reply, 400, 'invalid_provider', `Invalid provider: ${rawProvider}`);
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
      let baseUrl = bodyParse.data.baseUrl?.trim();

      if (provider === 'custom') {
        if (!baseUrl) {
          return sendError(reply, 400, 'custom_base_url_required', 'Base URL is required for custom provider');
        }
        try {
          baseUrl = await assertSafeBaseUrl(baseUrl);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return sendError(reply, 400, 'ssrf_validation_error', msg);
        }
      } else if (baseUrl) {
        try {
          baseUrl = await assertSafeBaseUrl(baseUrl);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return sendError(reply, 400, 'ssrf_validation_error', msg);
        }
      }

      try {
        await validateKeyFn(provider, apiKey, baseUrl);
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
          baseUrl,
        });

        return reply.status(200).send({
          provider: saved.provider,
          last4: saved.last4,
          baseUrl: saved.baseUrl ?? null,
          createdAt: toIso(saved.createdAt),
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
        return sendError(reply, 400, 'invalid_provider', `Invalid provider: ${rawProvider}`);
      }

      await deps.credentials.deleteKey(workspaceId, providerParse.data);
      return reply.status(204).send();
    },
  );

  // 7. GET /api/workspaces/:workspaceId/usage
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

  registerInstallationRoutes(app, deps);
  registerRunsRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerWorkspaceLifecycleRoutes(app, deps);
}

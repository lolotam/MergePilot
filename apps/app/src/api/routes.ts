import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from '../auth/auth.js';
import { isUserPlatformAdmin } from '../admin/guard.js';
import { requireRole } from '../auth/guard.js';
import type { FetchLike } from '@mergepilot/engine';
import type { AppConfig } from '../core/config.js';
import { createSafeFetch } from '../core/safe-fetch.js';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import { BotNameTakenError, type AppStore, type KeyProvider, type ReviewQueue } from '../core/types.js';
import type { CredentialService } from '../credentials/service.js';
import type { RunEventBus } from '../core/run-events.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import { KeyProviderSchema, SettingsUpdateSchema, SaveKeyRequestSchema } from './contract.js';
import { validateKey as defaultValidateKey } from './validate-key.js';
import {
  sendError,
  getAuthSession,
  getUserGitHubAccount,
  getUserWorkspaces,
} from './helpers.js';
import { registerInstallationRoutes } from './installation-routes.js';
import { registerJudgeRoutes } from './judge-routes.js';
import { registerPricesRoutes } from './prices-routes.js';
import { invalidateModelsCache, registerProviderRoutes } from './provider-routes.js';
import { registerRunsRoutes } from './runs-routes.js';
import type { RunStreamOptions } from './runs-events-routes.js';
import { registerBackupRoutes } from './backup-routes.js';
import { registerBotRoutes } from './bot-routes.js';
import { botNameTakenByExtraBot, mergeSettings, validateSettings } from './settings-validation.js';
import { registerWorkspaceLifecycleRoutes } from './workspace-lifecycle.js';

export interface DashboardApiDeps {
  auth: Auth;
  store: AppStore;
  credentials: CredentialService;
  validateKey?: (provider: KeyProvider, apiKey: string, baseUrl?: string) => Promise<void>;
  githubFetch?: typeof fetch;
  config: AppConfig;
  now?: () => Date;
  queue?: ReviewQueue;
  githubAppFactory?: GitHubAppClientFactory;
  /** Test seams for the custom base URL SSRF guard (ADR-0010): DNS lookup and guarded fetch. */
  ssrfLookup?: DnsLookupFn | undefined;
  customFetch?: FetchLike | undefined;
  /** Live run updates (ADR-0021); without it the stream answers 503 and the dashboard polls. */
  runEvents?: RunEventBus | undefined;
  /** Test seam: live stream limits and keep-alive interval. */
  runStreams?: Partial<RunStreamOptions> | undefined;
}

const toIso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function registerDashboardApi(
  app: FastifyInstance,
  deps: DashboardApiDeps,
): void {
  // `custom` is validated through the SSRF-guarded fetch; presets call their fixed URLs.
  const guardedFetch = deps.customFetch ?? createSafeFetch({ lookup: deps.ssrfLookup });
  const githubFetch = deps.githubFetch;
  const presetFetch: FetchLike | undefined = githubFetch ? (input, init) => githubFetch(input, init) : undefined;
  const validateKeyFn =
    deps.validateKey ??
    ((p, k, b) => (p === 'custom' ? defaultValidateKey(p, k, b ?? '', guardedFetch) : defaultValidateKey(p, k, presetFetch)));

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
      const parsed = SettingsUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          'validation_error',
          parsed.error.issues[0]?.message ?? 'Invalid settings',
        );
      }

      // A patch over the stored settings: fields left out keep their value, null clears them.
      const previous = await deps.store.getSettings(workspaceId);
      const merged = mergeSettings(workspaceId, previous, parsed.data);
      const problem = await validateSettings(deps.store, workspaceId, merged);
      if (problem) return sendError(reply, 400, problem.code, problem.message);
      // The main bot's name must differ from every extra bot's (ADR-0017).
      if (parsed.data.botName !== undefined && (await botNameTakenByExtraBot(deps.store, workspaceId, parsed.data.botName))) {
        return sendError(reply, 409, 'bot_name_taken', 'Another bot in this workspace already has this name');
      }

      try {
        await deps.store.saveSettings(merged);
      } catch (error) {
        // A bot saved the same name between the check above and this write (the store re-checks it under a lock).
        if (error instanceof BotNameTakenError) {
          return sendError(reply, 409, 'bot_name_taken', 'Another bot in this workspace already has this name');
        }
        throw error;
      }
      request.log.info(
        {
          event: 'settings.changed',
          workspaceId,
          // Only fields whose stored value really changed (forms resend unchanged values).
          changedFields: Object.keys(parsed.data).filter(
            (key) =>
              JSON.stringify((previous as Record<string, unknown> | null)?.[key] ?? null) !==
              JSON.stringify((merged as unknown as Record<string, unknown>)[key] ?? null),
          ),
        },
        'Workspace settings updated',
      );
      const { workspaceId: _ws, ...settings } = merged;
      return reply.status(200).send({ settings });
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
      const providerParse = KeyProviderSchema.safeParse(rawProvider);
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
          baseUrl = await assertSafeBaseUrl(baseUrl, deps.ssrfLookup);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Base URL is not allowed';
          return sendError(reply, 400, 'ssrf_validation_error', msg);
        }
      } else if (baseUrl) {
        return sendError(reply, 400, 'base_url_not_allowed', 'Only the custom provider takes a base URL');
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
        invalidateModelsCache(workspaceId, provider);
        request.log.info(
          {
            event: 'credential.key_saved',
            workspaceId,
            provider,
          },
          'Provider API key saved',
        );

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
      const providerParse = KeyProviderSchema.safeParse(rawProvider);
      if (!providerParse.success) {
        return sendError(reply, 400, 'invalid_provider', `Invalid provider: ${rawProvider}`);
      }

      await deps.credentials.deleteKey(workspaceId, providerParse.data);
      invalidateModelsCache(workspaceId, providerParse.data);
      request.log.info(
        {
          event: 'credential.key_deleted',
          workspaceId,
          provider: providerParse.data,
        },
        'Provider API key deleted',
      );
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
  registerJudgeRoutes(app, deps);
  registerPricesRoutes(app, deps);
  registerBotRoutes(app, deps);
  registerBackupRoutes(app, deps);
  registerWorkspaceLifecycleRoutes(app, deps);
}

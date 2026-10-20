import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from '../auth/auth.js';
import { isUserPlatformAdmin } from '../admin/guard.js';
import { requireRole } from '../auth/guard.js';
import { isSubscriptionOnlyProvider, SUBSCRIPTION_PREFIX, type FetchLike, type SubscriptionProvider } from '@mergepilot/engine';
import type { AppConfig } from '../core/config.js';
import { createSafeFetch } from '../core/safe-fetch.js';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import { BotNameTakenError, SettingsChangedError, UnknownSkillError, type AppStore, type KeyProvider, type ReviewQueue } from '../core/types.js';
import { canReplaySettingsPatch, reconcileSettingsPatch } from './settings-merge.js';
import { isKeyListProvider, MAX_PROVIDER_KEYS } from '../credentials/multi-key.js';
import { registerProviderAuthRoutes } from './provider-auth-routes.js';
import { KeyOrderError, SingleKeyProviderError, TooManyKeysError, type CredentialService } from '../credentials/service.js';
import type { RunEventBus } from '../core/run-events.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import { KeyProviderSchema, SettingsUpdateSchema, SaveKeysRequestSchema } from './contract.js';
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
import { registerProviderKeyRoutes } from './provider-key-routes.js';
import { registerRunsRoutes } from './runs-routes.js';
import type { RunStreamOptions } from './runs-events-routes.js';
import { registerBackupRoutes } from './backup-routes.js';
import { registerBotRoutes } from './bot-routes.js';
import {
  botNameTakenByExtraBot, mergeSettings, unavailableProviderProblem, unknownSkillProblem, validateSettings, withoutSkillFields,
} from './settings-validation.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerWorkspaceLifecycleRoutes } from './workspace-lifecycle.js';
import { registerSubscriptionRoutes, subscriptionAvailability } from './subscription-routes.js';
import type { SubscriptionLoginFn } from '../credentials/subscription-login.js';

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
  subscriptionLogin?: SubscriptionLoginFn | undefined;
  /** Test seam: which subscriptions this deployment offers (default: the server environment). */
  subscriptionAvailable?: ((provider: SubscriptionProvider) => boolean) | undefined;
}

const toIso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function redactSecrets(message: string, secrets: readonly string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, '[REDACTED]');
  }
  return safe;
}

function keyError(err: unknown, secrets: readonly string[]): { status: number; code: string; message: string } {
  if (err instanceof TooManyKeysError) {
    return { status: 400, code: 'too_many_keys', message: `This provider accepts at most ${MAX_PROVIDER_KEYS} API keys` };
  }
  if (err instanceof SingleKeyProviderError) {
    return { status: 400, code: 'single_key_provider', message: 'This provider stores one credential' };
  }
  if (err instanceof KeyOrderError) {
    return { status: 400, code: 'key_order', message: 'Key order must list every stored key exactly once' };
  }
  const raw = err instanceof Error ? err.message : String(err);
  return { status: 422, code: 'validation_failed', message: redactSecrets(raw, secrets) };
}

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

      const { base, ...submitted } = parsed.data;
      const replayable = canReplaySettingsPatch(submitted, base);
      for (let attempt = 0; attempt < 3; attempt++) {
        // A patch over the stored settings: fields left out keep their value, null clears them.
        const previous = await deps.store.getSettings(workspaceId);
        const patch = reconcileSettingsPatch(submitted, base, previous);
        if (!patch) return sendError(reply, 409, 'settings_conflict', 'Settings changed while saving; reload and try again');
        const merged = mergeSettings(workspaceId, previous, patch);
        const problem = unavailableProviderProblem(merged, previous, subscriptionAvailability(deps))
          ?? await validateSettings(deps.store, workspaceId, merged)
          ?? await unknownSkillProblem(deps.store, workspaceId, patch.skillId);
        if (problem) return sendError(reply, 400, problem.code, problem.message);
        // The main bot's name must differ from every extra bot's (ADR-0017).
        if (patch.botName !== undefined && (await botNameTakenByExtraBot(deps.store, workspaceId, patch.botName))) {
          return sendError(reply, 409, 'bot_name_taken', 'Another bot in this workspace already has this name');
        }

        try {
          await deps.store.saveSettings(patch.skillId === undefined ? withoutSkillFields(merged) : merged, { expected: previous });
        } catch (error) {
          if (error instanceof SettingsChangedError) {
            // A request is replayed only when its base covers every field it sends and every
            // member of a model group it touches (see canReplaySettingsPatch).
            if (!replayable) return sendError(reply, 409, 'settings_conflict', 'Settings changed while saving; reload and try again');
            continue;
          }
          // A bot saved the same name between the check above and this write (the store re-checks it under a lock).
          if (error instanceof BotNameTakenError) {
            return sendError(reply, 409, 'bot_name_taken', 'Another bot in this workspace already has this name');
          }
          // The skill was deleted between the check above and this write.
          if (error instanceof UnknownSkillError) return sendError(reply, 400, 'unknown_skill', error.message);
          throw error;
        }
        const stored = await deps.store.getSettings(workspaceId);
        request.log.info(
          {
            event: 'settings.changed',
            workspaceId,
            // Only fields whose stored value really changed (forms resend unchanged values).
            changedFields: Object.keys(patch).filter((key) => {
              const before = (previous as Record<string, unknown> | null)?.[key] ?? null;
              const applied = (merged as unknown as Record<string, unknown>)[key] ?? null;
              const after = (stored as Record<string, unknown> | null)?.[key] ?? null;
              return !isDeepStrictEqual(before, applied) && !isDeepStrictEqual(before, after);
            }),
          },
          'Workspace settings updated',
        );
        const { workspaceId: _ws, ...settings } = stored ?? merged;
        return reply.status(200).send({ settings: stored ? settings : null });
      }
      return sendError(reply, 409, 'settings_conflict', 'Settings changed while saving; reload and try again');
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
        authMethod: k.authMethod ?? 'api-key',
        ...(k.hasSubscription !== undefined ? { hasSubscription: k.hasSubscription } : {}),
        ...(k.defaultMethod ? { defaultMethod: k.defaultMethod } : {}),
        ...(k.keys
          ? {
              keys: k.keys.map((slot) => ({
                id: slot.id,
                position: slot.position,
                last4: slot.last4,
                createdAt: toIso(slot.createdAt),
                lastTestStatus: slot.lastTestStatus,
                lastTestedAt: slot.lastTestedAt ? toIso(slot.lastTestedAt) : null,
              })),
            }
          : {}),
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
      if (isSubscriptionOnlyProvider(provider)) {
        return sendError(reply, 400, 'subscription_only', 'This provider has no API keys; use its subscription sign-in');
      }

      const rawBody = request.body;
      const rawList = rawBody && typeof rawBody === 'object' && 'apiKeys' in rawBody
        ? (rawBody as { apiKeys?: unknown }).apiKeys
        : undefined;
      if (Array.isArray(rawList) && rawList.length > MAX_PROVIDER_KEYS) {
        return sendError(reply, 400, 'too_many_keys', `This provider accepts at most ${MAX_PROVIDER_KEYS} API keys`);
      }
      const bodyParse = SaveKeysRequestSchema.safeParse(rawBody);
      if (!bodyParse.success) {
        return sendError(
          reply,
          400,
          'validation_error',
          bodyParse.error.issues[0]?.message ?? 'Invalid apiKey',
        );
      }
      if (bodyParse.data.apiKeys && !isKeyListProvider(provider)) {
        return sendError(reply, 400, 'single_key_provider', 'This provider stores one credential');
      }
      const apiKeys = (bodyParse.data.apiKeys ?? [bodyParse.data.apiKey ?? '']).map((key) => key.trim());
      if (apiKeys.some((key) => key.startsWith(SUBSCRIPTION_PREFIX))) {
        return sendError(reply, 400, 'validation_error', 'Use subscription sign-in instead of the API key field');
      }
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
        for (const apiKey of apiKeys) await validateKeyFn(provider, apiKey, baseUrl);
      } catch (err) {
        return sendError(reply, 422, 'validation_failed', keyError(err, apiKeys).message);
      }

      const userId = request.auth?.userId ?? '';
      try {
        const saved = bodyParse.data.apiKeys
          ? await deps.credentials.saveKeyList({ workspaceId, provider, apiKeys, userId, baseUrl })
          : await deps.credentials.saveKey({ workspaceId, provider, apiKey: apiKeys[0] ?? '', userId, baseUrl });
        invalidateModelsCache(workspaceId, provider);
        request.log.info(
          {
            event: 'credential.key_saved',
            workspaceId,
            provider,
            keyCount: apiKeys.length,
          },
          'Provider API key saved',
        );

        return reply.status(200).send({
          provider: saved.provider,
          last4: saved.last4,
          baseUrl: saved.baseUrl ?? null,
          createdAt: toIso(saved.createdAt),
          createdBy: saved.createdBy,
          ...(saved.keys
            ? {
                keys: saved.keys.map((slot) => ({
                  id: slot.id,
                  position: slot.position,
                  last4: slot.last4,
                  createdAt: toIso(slot.createdAt),
                  lastTestStatus: slot.lastTestStatus,
                  lastTestedAt: slot.lastTestedAt ? toIso(slot.lastTestedAt) : null,
                })),
              }
            : {}),
        });
      } catch (err) {
        const mapped = keyError(err, apiKeys);
        return sendError(reply, mapped.status, mapped.code, mapped.message);
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

  registerProviderKeyRoutes(app, deps, validateKeyFn);
  registerProviderAuthRoutes(app, deps);
  registerInstallationRoutes(app, deps);
  registerRunsRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerSubscriptionRoutes(app, deps);
  registerJudgeRoutes(app, deps);
  registerPricesRoutes(app, deps);
  registerBotRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerBackupRoutes(app, deps);
  registerWorkspaceLifecycleRoutes(app, deps);
}

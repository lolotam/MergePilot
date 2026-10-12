import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  failureKind,
  LlmFailure,
  providerEntry,
  testConnection,
  listModels,
  type ApiProviderId,
  type CatalogModel,
} from '@mergepilot/engine';
import { requireRole } from '../auth/guard.js';
import { assertSafeBaseUrl, SsrFValidationError } from '../core/ssrf.js';
import type { ApiProvider } from '../core/types.js';
import {
  ApiProviderSchema,
  ListModelsBodySchema,
  TestConnectionBodySchema,
} from './contract.js';
import { sendError } from './helpers.js';
import type { DashboardApiDeps } from './routes.js';

function redactKey(text: string, key?: string): string {
  if (!key || !text) return text;
  return text.replaceAll(key, '[REDACTED]');
}

interface ModelsCacheEntry {
  expiresAt: number;
  models: CatalogModel[];
}

const modelsCache = new Map<string, ModelsCacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const testRateLimits = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

export function resetProviderTestRateLimits(): void {
  testRateLimits.clear();
  modelsCache.clear();
}

function checkRateLimit(workspaceId: string): boolean {
  const now = Date.now();
  let entry = testRateLimits.get(workspaceId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    testRateLimits.set(workspaceId, entry);
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  entry.count++;
  return true;
}

function mapFailureToStatus(kind: string): number {
  switch (kind) {
    case 'auth':
      return 422;
    case 'quota':
    case 'rate-limit':
      return 429;
    case 'network':
    case 'timeout':
    case 'server':
      return 502;
    default:
      return 422;
  }
}

export function registerProviderRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  // GET /api/workspaces/:workspaceId/providers/:provider/models
  app.get(
    '/api/workspaces/:workspaceId/providers/:provider/models',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, provider: rawProvider } = request.params as {
        workspaceId: string;
        provider: string;
      };
      const parseProvider = ApiProviderSchema.safeParse(rawProvider);
      if (!parseProvider.success) {
        return sendError(reply, 400, 'invalid_provider', `Unknown provider: ${rawProvider}`);
      }
      const provider = parseProvider.data as ApiProviderId;

      const query = request.query as { refresh?: string };
      const refresh = query?.refresh === 'true' || query?.refresh === '1';

      const cacheKey = `${workspaceId}:${provider}`;
      if (!refresh) {
        const cached = modelsCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
          return reply.status(200).send({ models: cached.models });
        }
      }

      const cred = await deps.store.getCredential(workspaceId, provider as ApiProvider);
      if (!cred) {
        return sendError(reply, 404, 'key_not_found', `No API key configured for provider "${provider}"`);
      }

      let secretValue: string;
      try {
        const resolved = await deps.credentials.resolve(workspaceId, provider as ApiProvider);
        secretValue = resolved.reveal();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, 404, 'key_not_found', msg);
      }

      let baseUrl = cred.baseUrl ?? undefined;
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
      }

      try {
        const models = await listModels(provider, secretValue, { ...(baseUrl ? { baseUrl } : {}) });
        modelsCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, models });
        return reply.status(200).send({ models });
      } catch (err) {
        if (err instanceof SsrFValidationError) {
          return sendError(reply, 400, 'ssrf_validation_error', err.message);
        }
        if (err instanceof LlmFailure) {
          const kind = failureKind(err.code);
          const status = mapFailureToStatus(kind);
          return sendError(reply, status, kind, redactKey(err.message, secretValue));
        }
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, 422, 'models_fetch_failed', redactKey(msg, secretValue));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/providers/:provider/models (unsaved key test)
  app.post(
    '/api/workspaces/:workspaceId/providers/:provider/models',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { provider: rawProvider } = request.params as {
        workspaceId: string;
        provider: string;
      };
      const parseProvider = ApiProviderSchema.safeParse(rawProvider);
      if (!parseProvider.success) {
        return sendError(reply, 400, 'invalid_provider', `Unknown provider: ${rawProvider}`);
      }
      const provider = parseProvider.data as ApiProviderId;

      const parsedBody = ListModelsBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return sendError(
          reply,
          400,
          'validation_error',
          parsedBody.error.issues[0]?.message ?? 'Invalid request body',
        );
      }
      const apiKey = parsedBody.data.apiKey.trim();
      let baseUrl = parsedBody.data.baseUrl?.trim();

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
        const models = await listModels(provider, apiKey, { ...(baseUrl ? { baseUrl } : {}) });
        return reply.status(200).send({ models });
      } catch (err) {
        if (err instanceof SsrFValidationError) {
          return sendError(reply, 400, 'ssrf_validation_error', err.message);
        }
        if (err instanceof LlmFailure) {
          const kind = failureKind(err.code);
          const status = mapFailureToStatus(kind);
          return sendError(reply, status, kind, redactKey(err.message, apiKey));
        }
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, 422, 'models_fetch_failed', redactKey(msg, apiKey));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/credentials/:provider/test
  app.post(
    '/api/workspaces/:workspaceId/credentials/:provider/test',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, provider: rawProvider } = request.params as {
        workspaceId: string;
        provider: string;
      };
      const parseProvider = ApiProviderSchema.safeParse(rawProvider);
      if (!parseProvider.success) {
        return sendError(reply, 400, 'invalid_provider', `Unknown provider: ${rawProvider}`);
      }
      const provider = parseProvider.data as ApiProviderId;

      if (!checkRateLimit(workspaceId)) {
        return sendError(reply, 429, 'rate_limited', 'Rate limit exceeded: 10 tests per minute per workspace');
      }

      const bodyParse = TestConnectionBodySchema.safeParse(request.body ?? {});
      const body = bodyParse.success ? bodyParse.data : {};

      let apiKey = body.apiKey?.trim();
      let baseUrl = body.baseUrl?.trim();

      if (!apiKey) {
        const cred = await deps.store.getCredential(workspaceId, provider as ApiProvider);
        if (!cred) {
          return sendError(reply, 404, 'key_not_found', `No credential stored for provider "${provider}"`);
        }
        try {
          const resolved = await deps.credentials.resolve(workspaceId, provider as ApiProvider);
          apiKey = resolved.reveal();
          baseUrl = cred.baseUrl ?? undefined;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return sendError(reply, 404, 'key_not_found', msg);
        }
      }

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

      const defaultModel = providerEntry(provider)?.defaultModel || 'gpt-4o';
      const model = body.model?.trim() || defaultModel;
      const effort = body.effort?.trim();

      try {
        const result = await testConnection(provider, apiKey, model, {
          ...(baseUrl ? { baseUrl } : {}),
          ...(effort ? { effort } : {}),
        });

        if (result.ok) {
          return reply.status(200).send({
            ok: true,
            ms: result.ms,
            model: result.model,
          });
        }

        return reply.status(200).send({
          ok: false,
          code: result.code,
          message: redactKey(result.message, apiKey),
          ms: result.ms,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(200).send({
          ok: false,
          code: 'network',
          message: redactKey(msg, apiKey),
        });
      }
    },
  );
}

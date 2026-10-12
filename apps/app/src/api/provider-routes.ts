import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  failureKind,
  listModels,
  LlmFailure,
  providerEntry,
  testConnection,
  type ApiProviderId,
  type CatalogModel,
} from '@mergepilot/engine';
import { requireRole } from '../auth/guard.js';
import { DASHBOARD_FETCH_LIMITS } from '../core/safe-fetch.js';
import type { WorkspaceSettings } from '../core/types.js';
import { ApiProviderSchema, ListModelsBodySchema, TestConnectionBodySchema } from './contract.js';
import { sendError } from './helpers.js';
import { engineOptions, storedTarget, unsavedTarget, type TargetResult } from './provider-target.js';
import type { DashboardApiDeps } from './routes.js';

/**
 * Model catalog and connection-test routes (J2). A key typed into the "add key" dialog may be
 * sent here BEFORE it is saved: it is used for that one provider call only, never stored, never
 * logged, and every message that could carry it is redacted.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const modelsCache = new Map<string, { expiresAt: number; models: CatalogModel[] }>();

const RATE_WINDOW_MS = 60 * 1000;
const TEST_LIMIT = 10;
const UNSAVED_MODELS_LIMIT = 20;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/** Test helper: forget every cached model list and rate-limit bucket. */
export function resetProviderTestRateLimits(): void {
  rateBuckets.clear();
  modelsCache.clear();
}

/** Drops a workspace's cached model list for one provider (its key changed or was removed). */
export function invalidateModelsCache(workspaceId: string, provider: string): void {
  modelsCache.delete(`${workspaceId}:${provider}`);
}

function cacheModels(key: string, models: CatalogModel[]): void {
  const now = Date.now();
  if (modelsCache.size >= CACHE_MAX_ENTRIES) {
    for (const [k, v] of modelsCache) if (v.expiresAt <= now) modelsCache.delete(k);
    if (modelsCache.size >= CACHE_MAX_ENTRIES) modelsCache.clear();
  }
  modelsCache.set(key, { expiresAt: now + CACHE_TTL_MS, models });
}

function allow(bucket: string, limit: number): boolean {
  const now = Date.now();
  const entry = rateBuckets.get(bucket);
  if (!entry || now >= entry.resetAt) {
    rateBuckets.set(bucket, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function statusFor(kind: string): number {
  if (kind === 'quota' || kind === 'rate-limit') return 429;
  if (kind === 'network' || kind === 'timeout' || kind === 'server') return 502;
  return 422;
}

function redact(text: string, key: string): string {
  return key ? text.replaceAll(key, '[REDACTED]') : text;
}

function parseProvider(request: FastifyRequest, reply: FastifyReply): ApiProviderId | undefined {
  const raw = (request.params as { provider?: string }).provider ?? '';
  const parsed = ApiProviderSchema.safeParse(raw);
  if (!parsed.success) {
    sendError(reply, 400, 'invalid_provider', 'Unknown provider');
    return undefined;
  }
  return parsed.data;
}

/**
 * Aborts the provider call when the dashboard request goes away or after the dashboard limit;
 * the guarded custom fetch adds its own timeout, idle timeout and size cap on top.
 */
function routeSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DASHBOARD_FETCH_LIMITS.timeoutMs);
  reply.raw.once('close', () => {
    clearTimeout(timer);
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/**
 * Picks a free model for providers known to have free tiers (OpenRouter, OpenCode Zen).
 */
export function pickFreeModel(
  provider: ApiProviderId,
  models: readonly (CatalogModel | { id: string })[],
): string | undefined {
  if (provider === 'openrouter') {
    return models.find((m) => m.id.endsWith(':free'))?.id;
  }
  if (provider === 'opencode-zen') {
    return models.find((m) => m.id.includes('free'))?.id;
  }
  return undefined;
}

/**
 * The model explicitly configured in workspace settings for this provider (primary, heavy, or fallback).
 */
export function configuredModelFor(settings: WorkspaceSettings | null, provider: ApiProviderId): string | undefined {
  if (settings?.provider === provider && settings.model) return settings.model;
  if (settings?.heavyProvider === provider && settings.heavyModel) return settings.heavyModel;
  const fallback = settings?.fallback?.find((f) => f.provider === provider && f.model);
  return fallback?.model;
}

/**
 * The model a connection test uses when the request names none: the workspace's primary model,
 * then its heavy model, then its first fallback for this provider, then a free model from the
 * provider's models list (OpenRouter / OpenCode Zen), then the registry default
 * (`custom` has none, so a custom key used only as heavy/fallback still tests its own model).
 */
export function testModelFor(
  settings: WorkspaceSettings | null,
  provider: ApiProviderId,
  models?: readonly CatalogModel[],
): string {
  const configured = configuredModelFor(settings, provider);
  if (configured) return configured;
  if (models && models.length > 0) {
    const free = pickFreeModel(provider, models);
    if (free) return free;
  }
  return providerEntry(provider).defaultModel;
}

function sendTargetError(reply: FastifyReply, result: Exclude<TargetResult, { ok: true }>): FastifyReply {
  return sendError(reply, result.status, result.code, result.message);
}

async function fetchModels(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: ApiProviderId,
  result: Extract<TargetResult, { ok: true }>,
  signal: AbortSignal,
  cacheKey?: string,
): Promise<FastifyReply> {
  const { target } = result;
  const start = Date.now();
  try {
    const models = await listModels(provider, target.apiKey, { ...engineOptions(target), signal });
    const ms = Date.now() - start;
    if (cacheKey) cacheModels(cacheKey, models);
    request.log.info(
      {
        event: 'provider.models_listed',
        provider,
        ok: true,
        count: models.length,
        ms,
        cached: false,
      },
      'Provider models listed',
    );
    return reply.status(200).send({ models });
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof LlmFailure) {
      const kind = failureKind(err.code);
      request.log.info(
        {
          event: 'provider.models_listed',
          provider,
          ok: false,
          code: kind,
          count: 0,
          ms,
          cached: false,
        },
        'Provider models listing failed',
      );
      return sendError(reply, statusFor(kind), kind, redact(err.message, target.apiKey));
    }
    const msg = err instanceof Error ? err.message : String(err);
    request.log.info(
      {
        event: 'provider.models_listed',
        provider,
        ok: false,
        code: 'models_fetch_failed',
        count: 0,
        ms,
        cached: false,
      },
      'Provider models listing failed',
    );
    return sendError(reply, 502, 'models_fetch_failed', redact(msg, target.apiKey));
  }
}

export function registerProviderRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  // Model list with the workspace's stored key. Members may read it (it reveals no secret).
  app.get(
    '/api/workspaces/:workspaceId/providers/:provider/models',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseProvider(request, reply);
      if (!provider) return reply;
      const { refresh } = (request.query ?? {}) as { refresh?: string };
      const cacheKey = `${workspaceId}:${provider}`;
      if (refresh !== 'true' && refresh !== '1') {
        const cached = modelsCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
          request.log.info(
            {
              event: 'provider.models_listed',
              provider,
              ok: true,
              count: cached.models.length,
              ms: 0,
              cached: true,
            },
            'Provider models listed',
          );
          return reply.status(200).send({ models: cached.models });
        }
      }
      const signal = routeSignal(reply);
      const result = await storedTarget(deps, workspaceId, provider, signal);
      if (!result.ok) return sendTargetError(reply, result);
      return fetchModels(request, reply, provider, result, signal, cacheKey);
    },
  );

  // Model list with a key typed in the "add key" dialog, before it is saved (admins only).
  app.post(
    '/api/workspaces/:workspaceId/providers/:provider/models',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseProvider(request, reply);
      if (!provider) return reply;
      const body = ListModelsBodySchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'validation_error', 'apiKey is required');
      if (!allow(`${workspaceId}:models`, UNSAVED_MODELS_LIMIT)) {
        return sendError(reply, 429, 'rate_limited', `Too many requests: ${UNSAVED_MODELS_LIMIT} per minute per workspace`);
      }
      const signal = routeSignal(reply);
      const result = await unsavedTarget(deps, provider, body.data.apiKey, body.data.baseUrl, signal);
      if (!result.ok) return sendTargetError(reply, result);
      return fetchModels(request, reply, provider, result, signal);
    },
  );

  // Connection test: stored key, or an unsaved key for "test before saving" (admins only).
  app.post(
    '/api/workspaces/:workspaceId/credentials/:provider/test',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseProvider(request, reply);
      if (!provider) return reply;
      const parsed = TestConnectionBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, 'validation_error', 'Invalid test request');
      const body = parsed.data;
      if (!allow(`${workspaceId}:test`, TEST_LIMIT)) {
        return sendError(reply, 429, 'rate_limited', `Rate limit exceeded: ${TEST_LIMIT} tests per minute per workspace`);
      }

      const apiKey = body.apiKey?.trim();
      const signal = routeSignal(reply);
      const result = apiKey
        ? await unsavedTarget(deps, provider, apiKey, body.baseUrl, signal)
        : await storedTarget(deps, workspaceId, provider, signal);
      if (!result.ok) return sendTargetError(reply, result);
      const { target } = result;

      const settings = await deps.store.getSettings(workspaceId);
      let model = body.model?.trim() || configuredModelFor(settings, provider);
      if (!model) {
        const cacheKey = `${workspaceId}:${provider}`;
        let models: CatalogModel[] | undefined;
        const cached = modelsCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
          models = cached.models;
        } else {
          try {
            models = await listModels(provider, target.apiKey, { ...engineOptions(target), signal });
            cacheModels(cacheKey, models);
          } catch {
            // If listing models fails, ignore and fall back to default
          }
        }
        model = testModelFor(settings, provider, models);
      }
      if (!model) return sendError(reply, 400, 'model_required', 'Choose a model to test this provider');
      const effort = body.effort?.trim();

      const start = Date.now();
      try {
        const outcome = await testConnection(provider, target.apiKey, model, {
          ...engineOptions(target),
          timeoutMs: DASHBOARD_FETCH_LIMITS.timeoutMs,
          ...(effort ? { effort } : {}),
        });
        if (outcome.ok) {
          request.log.info(
            {
              event: 'provider.test_connection',
              provider,
              model: outcome.model ?? model,
              ok: true,
              ms: outcome.ms,
            },
            'Provider connection tested',
          );
          return reply.status(200).send({ ok: true, ms: outcome.ms, model: outcome.model });
        }
        request.log.info(
          {
            event: 'provider.test_connection',
            provider,
            model,
            ok: false,
            code: outcome.code,
            ms: outcome.ms,
          },
          'Provider connection test failed',
        );
        return reply.status(200).send({
          ok: false,
          code: outcome.code,
          message: redact(outcome.message, target.apiKey),
          ms: outcome.ms,
        });
      } catch (err) {
        const ms = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        request.log.info(
          {
            event: 'provider.test_connection',
            provider,
            model,
            ok: false,
            code: 'network',
            ms,
          },
          'Provider connection test failed',
        );
        return reply.status(200).send({ ok: false, code: 'network', message: redact(msg, target.apiKey) });
      }
    },
  );
}

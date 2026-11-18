import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  decodeSubscription,
  failureKind,
  isSubscriptionAvailable,
  listModels,
  LlmFailure,
  providerEntry,
  testConnection,
  redactSecrets,
  Secret,
  type ApiProviderId,
  type CatalogModel,
} from '@mergepilot/engine';
import { requireRole } from '../auth/guard.js';
import { DASHBOARD_FETCH_LIMITS, SafeFetchTimeoutError } from '../core/safe-fetch.js';
import type { KeyQuotaStatus, WorkspaceSettings } from '../core/types.js';
import { ApiProviderSchema, ListModelsBodySchema, TestConnectionBodySchema } from './contract.js';
import { sendError } from './helpers.js';
import { engineOptions, storedKeyById, storedTarget, unsavedTarget, type ProviderTarget, type TargetResult } from './provider-target.js';
import type { DashboardApiDeps } from './routes.js';
import { beginCatalogRead, cachedCatalog, catalogCredentialRevision, resetCatalogCache } from './provider-catalog-cache.js';

export { invalidateModelsCache } from './provider-catalog-cache.js';

/**
 * Model catalog and connection-test routes (J2). A key typed into the "add key" dialog may be
 * sent here BEFORE it is saved: it is used for that one provider call only, never stored, never
 * logged, and every message that could carry it is redacted.
 */

const RATE_WINDOW_MS = 60 * 1000;
export const TEST_LIMIT = 10;
const UNSAVED_MODELS_LIMIT = 20;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/** Only a definite answer is stored: transient failures (rate limit, server, network) keep the prior status. */
function quotaStatusOf(ok: boolean, code: string | undefined): KeyQuotaStatus | null {
  if (ok) return 'valid';
  if (code === 'quota') return 'quota-exhausted';
  return code === 'auth' ? 'invalid' : null;
}

/** Test helper: forget every cached model list and rate-limit bucket. */
export function resetProviderTestRateLimits(): void {
  rateBuckets.clear();
  resetCatalogCache();
}

export function allow(bucket: string, limit: number): boolean {
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

export function redact(text: string, key: string): string {
  return key ? redactSecrets(text, [new Secret(key)]).text.replaceAll('[REDACTED:known]', '[REDACTED]') : text;
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
export function routeSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  if (reply.raw.destroyed) { controller.abort(); return controller.signal; }
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
 * With no explicit or workspace model, prefer a free catalog model, then the registry default
 * when listed, then the first catalog model.
 */
function testModelFor(provider: ApiProviderId, models?: readonly CatalogModel[]): string {
  const fallback = providerEntry(provider).defaultModel;
  if (models && models.length > 0) {
    const free = pickFreeModel(provider, models);
    if (free) return free;
    // A registry default the provider no longer lists (retired model) would fail a valid key.
    if (!models.some((m) => m.id === fallback)) return models[0]?.id ?? fallback;
  }
  return fallback;
}

function sendTargetError(reply: FastifyReply, result: Exclude<TargetResult, { ok: true }>): FastifyReply {
  return sendError(reply, result.status, result.code, result.message);
}

interface CatalogRequest {
  provider: ApiProviderId;
  target: ProviderTarget;
  signal: AbortSignal;
  mode?: 'sync';
  publish?: (models: CatalogModel[], commit?: () => void) => Promise<{ models: CatalogModel[] } | 'catalog_credentials_changed' | 'catalog_superseded'>;
}

async function fetchModels(
  request: FastifyRequest,
  reply: FastifyReply,
  { provider, target, signal, mode, publish }: CatalogRequest,
): Promise<FastifyReply> {
  const sync = mode === 'sync';
  const start = Date.now();
  try {
    let commitCatalog: (() => void) | undefined;
    let models = await listModels(provider, target.apiKey, {
      ...engineOptions(target), signal,
      ...(sync ? { strictRefresh: true, deferAntigravityCacheWrite: (commit) => { commitCatalog = commit; } } : {}),
    });
    signal.throwIfAborted();
    if (publish) {
      const publication = await publish(models, commitCatalog);
      if (typeof publication === 'string') {
        return sendError(reply, 409, publication, 'The catalog request is outdated. Refresh the model catalog again.');
      }
      models = publication.models;
    }
    const ms = Date.now() - start;
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
    const subscription = sync && decodeSubscription(target.apiKey, provider);
    const source = subscription && subscription.provider !== 'google-antigravity' ? 'bundled' : 'live';
    return reply.status(200).send({ models, ...(sync ? { source } : {}) });
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
      return sendError(reply, statusFor(kind), kind, sync ? 'Could not sync model catalog' : redact(err.message, target.apiKey));
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
    return sendError(reply, 502, 'models_fetch_failed', sync ? 'Could not sync model catalog' : redact(msg, target.apiKey));
  }
}

function isModelSync(request: FastifyRequest): boolean {
  return (request.query as { sync?: string } | undefined)?.sync === 'true';
}

export function registerProviderRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  const readModels = requireRole('member', deps.auth);
  const syncModels = requireRole('admin', deps.auth);
  // Model list with the workspace's stored key. Members may read it (it reveals no secret).
  app.get(
    '/api/workspaces/:workspaceId/providers/:provider/models',
    { preHandler: [(request, reply) => (isModelSync(request) ? syncModels : readModels)(request, reply)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseProvider(request, reply);
      if (!provider) return reply;
      const { refresh } = (request.query ?? {}) as { refresh?: string };
      const sync = isModelSync(request);
      if (sync) reply.header('Cache-Control', 'no-store');
      if (sync && provider === 'google-antigravity' && !(deps.subscriptionAvailable ?? isSubscriptionAvailable)(provider)) {
        return sendError(reply, 400, 'provider_unavailable', 'This server does not offer Google Antigravity');
      }
      const cacheKey = `${workspaceId}:${provider}`;
      const signal = routeSignal(reply);
      const { revision, slotId } = await catalogCredentialRevision(deps.store, workspaceId, provider);
      signal.throwIfAborted();
      if (!sync && refresh !== 'true' && refresh !== '1') {
        const cached = cachedCatalog(cacheKey, revision);
        if (cached) {
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
      const read = beginCatalogRead(cacheKey, revision, sync ? 'sync' : 'ordinary');
      try {
        const result = await storedTarget(deps, workspaceId, provider, signal);
        if (!result.ok) return sendTargetError(reply, result);
        const resolvedSlot = result.target.slotId;
        if ((resolvedSlot !== undefined && resolvedSlot !== slotId) ||
          (await catalogCredentialRevision(deps.store, workspaceId, provider)).revision !== revision) {
          return sendError(reply, 409, 'catalog_credentials_changed', 'The catalog request is outdated. Refresh the model catalog again.');
        }
        signal.throwIfAborted();
        const publish: NonNullable<CatalogRequest['publish']> = async (models, commit) => {
          const current = await catalogCredentialRevision(deps.store, workspaceId, provider);
          signal.throwIfAborted();
          if (current.revision !== revision) return 'catalog_credentials_changed';
          const publication = read.publish(models);
          if (typeof publication !== 'string') commit?.();
          return publication;
        };
        return await fetchModels(request, reply, {
          provider, target: result.target, signal, publish, ...(sync ? { mode: 'sync' } : {}),
        });
      } finally {
        read.finish();
      }
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
      return fetchModels(request, reply, { provider, target: result.target, signal });
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
      const keyId = body.keyId;
      const signal = routeSignal(reply);
      const result = apiKey
        ? await unsavedTarget(deps, provider, apiKey, body.baseUrl, signal)
        : keyId
          ? await storedKeyById(deps, workspaceId, provider, keyId, signal)
          : await storedTarget(deps, workspaceId, provider, signal);
      if (!result.ok) return sendTargetError(reply, result);
      const { target } = result;
      const recordOutcome = async (ok: boolean, code?: string) => {
        const status = quotaStatusOf(ok, code);
        if (!keyId || !status) return status;
        try {
          return await deps.credentials.recordKeyTest(workspaceId, provider, keyId, status, new Date()) ? status : null;
        } catch {
          request.log.warn({ event: 'provider.key_test_status_write_failed', provider }, 'Could not save provider key test status');
          return null;
        }
        return status;
      };

      const settings = keyId ? null : await deps.store.getSettings(workspaceId);
      let model = body.model?.trim() || configuredModelFor(settings, provider);
      if (!model) {
        const accountCatalogRequired = Boolean(keyId) || provider === 'openrouter';
        let models: CatalogModel[] | undefined;
        const catalogStart = Date.now();
        try {
          // The test may have resolved a different key than the latest picker catalog.
          models = await listModels(provider, target.apiKey, {
            ...engineOptions(target), signal,
            ...((accountCatalogRequired || provider === 'google-antigravity') ? { strictRefresh: true } : {}),
          });
          signal.throwIfAborted();
        } catch (error: unknown) {
          if (reply.raw.destroyed) return reply;
          if (signal.aborted || error instanceof SafeFetchTimeoutError || (error instanceof LlmFailure && error.code === 'TIMEOUT')) {
            return reply.status(200).send({
              ok: false, code: 'network', message: 'Provider model catalog did not answer in time', ms: Date.now() - catalogStart,
            });
          }
          if (accountCatalogRequired) {
            const code = error instanceof LlmFailure ? failureKind(error.code) : 'network';
            const quotaStatus = await recordOutcome(false, code);
            return reply.status(200).send({
              ok: false, code, message: 'Could not read the provider account catalog',
              ms: Date.now() - catalogStart, ...(quotaStatus ? { quotaStatus } : {}),
            });
          }
          // Other providers can still use their registry default when model listing fails.
          request.log.warn(
            { event: 'provider.test_model_list_failed', provider, code: error instanceof LlmFailure ? error.code : 'error' },
            'Could not list models to pick a test model; using the registry default',
          );
        }
        model = accountCatalogRequired && !models?.length ? '' : testModelFor(provider, models);
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
        const quotaStatus = await recordOutcome(outcome.ok, outcome.ok ? undefined : outcome.code);
        if (outcome.ok) {
          request.log.info(
            {
              event: 'provider.test_connection',
              provider,
              model: outcome.model ?? model,
              ok: true,
              ms: outcome.ms,
              quotaStatus,
            },
            'Provider connection tested',
          );
          return reply.status(200).send({ ok: true, ms: outcome.ms, model: outcome.model, ...(quotaStatus ? { quotaStatus } : {}) });
        }
        request.log.info(
          {
            event: 'provider.test_connection',
            provider,
            model,
            ok: false,
            code: outcome.code,
            ms: outcome.ms,
            quotaStatus,
          },
          'Provider connection test failed',
        );
        return reply.status(200).send({
          ok: false,
          code: outcome.code,
          message: redact(outcome.message, target.apiKey),
          ms: outcome.ms,
          ...(quotaStatus ? { quotaStatus } : {}),
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
        return reply.status(200).send({
          ok: false,
          code: 'network',
          message: redact(msg, target.apiKey),
          ms,
        });
      }
    },
  );
}

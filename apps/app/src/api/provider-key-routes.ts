import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth/guard.js';
import type { KeyProvider } from '../core/types.js';
import { isKeyListProvider, MAX_PROVIDER_KEYS } from '../credentials/multi-key.js';
import {
  KeyOrderError,
  SingleKeyProviderError,
  SubscriptionEnvelopeInKeyListError,
  TooManyKeysError,
  UnreadableCredentialError,
  type CredentialService,
} from '../credentials/service.js';
import { AppendKeyRequestSchema, KeyProviderSchema, ReorderKeysRequestSchema } from './contract.js';
import { sendError } from './helpers.js';
import { invalidateModelsCache } from './provider-routes.js';
import type { DashboardApiDeps } from './routes.js';

const toIso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function redactSecrets(message: string, secrets: readonly string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, '[REDACTED]');
  }
  return safe;
}

function knownKeyError(err: unknown): { status: number; code: string; message: string } | null {
  if (err instanceof TooManyKeysError) {
    return { status: 400, code: 'too_many_keys', message: `This provider accepts at most ${MAX_PROVIDER_KEYS} API keys` };
  }
  if (err instanceof SingleKeyProviderError) {
    return { status: 400, code: 'single_key_provider', message: 'This provider stores one credential' };
  }
  if (err instanceof KeyOrderError) {
    return { status: 400, code: 'key_order', message: 'Key order must list every stored key exactly once' };
  }
  if (err instanceof SubscriptionEnvelopeInKeyListError) {
    return { status: 400, code: 'subscription_in_key_list', message: err.message };
  }
  if (err instanceof UnreadableCredentialError) {
    return { status: 500, code: 'credential_unreadable', message: 'The stored credential could not be read' };
  }
  return null;
}

function validationFailedMessage(err: unknown, secrets: readonly string[]): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, secrets);
}

function slotBody(slot: { id: string; position: number; last4: string; createdAt: Date; lastTestStatus: string | null; lastTestedAt: Date | null }) {
  return {
    id: slot.id,
    position: slot.position,
    last4: slot.last4,
    createdAt: toIso(slot.createdAt),
    lastTestStatus: slot.lastTestStatus,
    lastTestedAt: slot.lastTestedAt ? toIso(slot.lastTestedAt) : null,
  };
}

function parseProvider(request: FastifyRequest, reply: FastifyReply): KeyProvider | undefined {
  const { provider: raw } = request.params as { provider: string };
  const parsed = KeyProviderSchema.safeParse(raw);
  if (!parsed.success) {
    void sendError(reply, 400, 'invalid_provider', `Invalid provider: ${raw}`);
    return undefined;
  }
  if (!isKeyListProvider(parsed.data)) {
    void sendError(reply, 400, 'single_key_provider', 'This provider stores one credential');
    return undefined;
  }
  return parsed.data;
}

/** Append, delete and reorder the ordered API keys of gemini, openrouter and opencode-zen. */
export function registerProviderKeyRoutes(
  app: FastifyInstance,
  deps: Pick<DashboardApiDeps, 'auth' | 'credentials'>,
  validateKeyFn: (provider: KeyProvider, apiKey: string, baseUrl?: string) => Promise<void>,
): void {
  const credentials: CredentialService = deps.credentials;

  app.post(
    '/api/workspaces/:workspaceId/keys/:provider/slots',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseProvider(request, reply);
      if (!provider) return reply;
      const body = AppendKeyRequestSchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'validation_error', body.error.issues[0]?.message ?? 'Invalid apiKey');
      const apiKey = body.data.apiKey.trim();
      try {
        await validateKeyFn(provider, apiKey);
      } catch (err) {
        return sendError(reply, 422, 'validation_failed', validationFailedMessage(err, [apiKey]));
      }
      try {
        const saved = await credentials.appendProviderKey({
          workspaceId,
          provider,
          apiKey,
          userId: request.auth?.userId ?? '',
        });
        invalidateModelsCache(workspaceId, provider);
        request.log.info({ event: 'credential.key_appended', workspaceId, provider, position: saved.position }, 'Provider API key appended');
        return reply.status(201).send(slotBody(saved));
      } catch (err) {
        const mapped = knownKeyError(err);
        if (mapped) return sendError(reply, mapped.status, mapped.code, mapped.message);
        request.log.error({ event: 'credential.key_append_failed', workspaceId, provider, error: err instanceof Error ? err.name : 'unknown' }, 'Provider API key append failed');
        return sendError(reply, 500, 'internal_error', 'Internal server error');
      }
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/keys/:provider/slots/:keyId',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId, keyId } = request.params as { workspaceId: string; keyId: string };
      const provider = parseProvider(request, reply);
      if (!provider) return reply;
      const removed = await credentials.deleteProviderKey(workspaceId, provider, keyId);
      if (!removed) return sendError(reply, 404, 'key_not_found', 'Stored API key was not found');
      invalidateModelsCache(workspaceId, provider);
      request.log.info({ event: 'credential.key_slot_deleted', workspaceId, provider }, 'Provider API key removed');
      return reply.status(204).send();
    },
  );

  app.put(
    '/api/workspaces/:workspaceId/keys/:provider/order',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseProvider(request, reply);
      if (!provider) return reply;
      const body = ReorderKeysRequestSchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'validation_error', body.error.issues[0]?.message ?? 'Invalid key order');
      try {
        const keys = await credentials.reorderProviderKeys(workspaceId, provider, body.data.ids);
        request.log.info({ event: 'credential.key_reordered', workspaceId, provider, keyCount: keys.length }, 'Provider API keys reordered');
        return reply.status(200).send({ keys: keys.map(slotBody) });
      } catch (err) {
        const mapped = knownKeyError(err);
        if (mapped) return sendError(reply, mapped.status, mapped.code, mapped.message);
        request.log.error({ event: 'credential.key_reorder_failed', workspaceId, provider, error: err instanceof Error ? err.name : 'unknown' }, 'Provider API key reorder failed');
        return sendError(reply, 500, 'internal_error', 'Internal server error');
      }
    },
  );
}

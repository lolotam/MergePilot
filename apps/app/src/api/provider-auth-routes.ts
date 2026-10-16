import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/guard.js';
import type { SubscriptionProvider } from '@mergepilot/engine';
import type { KeyProvider } from '../core/types.js';
import { isDualMethodProvider } from '../credentials/multi-key.js';
import {
  NoSubscriptionConnectedError,
  SingleKeyProviderError,
  UnavailableAuthMethodError,
  UnreadableCredentialError,
  type CredentialService,
} from '../credentials/service.js';
import { KeyProviderSchema } from './contract.js';
import { sendError } from './helpers.js';
import { allow, invalidateModelsCache } from './provider-routes.js';
import type { DashboardApiDeps } from './routes.js';

/** Per workspace and per route, per minute: each change takes the provider credential lock. */
export const PROVIDER_AUTH_LIMIT = 20;

const DefaultMethodBodySchema = z.object({
  method: z.enum(['subscription', 'api-key']),
});

function parseDualProvider(request: FastifyRequest, reply: FastifyReply): KeyProvider | undefined {
  const { provider: raw } = request.params as { provider: string };
  const parsed = KeyProviderSchema.safeParse(raw);
  if (!parsed.success) {
    void sendError(reply, 400, 'invalid_provider', `Invalid provider: ${raw}`);
    return undefined;
  }
  if (!isDualMethodProvider(parsed.data)) {
    void sendError(reply, 400, 'single_key_provider', 'This provider stores one credential');
    return undefined;
  }
  return parsed.data;
}

/** Default auth method and subscription disconnect for dual-method providers (ADR-0027). */
export function registerProviderAuthRoutes(
  app: FastifyInstance,
  deps: Pick<DashboardApiDeps, 'auth' | 'credentials'>,
): void {
  const credentials: CredentialService = deps.credentials;

  app.put(
    '/api/workspaces/:workspaceId/keys/:provider/default-method',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseDualProvider(request, reply);
      if (!provider) return reply;
      if (!allow(`${workspaceId}:default-method`, PROVIDER_AUTH_LIMIT)) {
        return sendError(reply, 429, 'rate_limited', `Too many requests: ${PROVIDER_AUTH_LIMIT} per minute per workspace`);
      }
      const body = DefaultMethodBodySchema.safeParse(request.body);
      if (!body.success) {
        return sendError(reply, 400, 'validation_error', body.error.issues[0]?.message ?? 'Invalid method');
      }
      try {
        await credentials.setProviderDefaultMethod(workspaceId, provider, body.data.method);
        invalidateModelsCache(workspaceId, provider);
        request.log.info(
          { event: 'credential.default_method_set', workspaceId, provider, method: body.data.method },
          'Provider default auth method updated',
        );
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof UnavailableAuthMethodError) {
          return sendError(reply, 400, 'method_unavailable', err.message);
        }
        if (err instanceof SingleKeyProviderError) {
          return sendError(reply, 400, 'single_key_provider', err.message);
        }
        if (err instanceof UnreadableCredentialError) {
          return sendError(reply, 500, 'credential_unreadable', 'The stored credential could not be read');
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/keys/:provider/subscription',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const provider = parseDualProvider(request, reply);
      if (!provider) return reply;
      if (!allow(`${workspaceId}:subscription-disconnect`, PROVIDER_AUTH_LIMIT)) {
        return sendError(reply, 429, 'rate_limited', `Too many requests: ${PROVIDER_AUTH_LIMIT} per minute per workspace`);
      }
      try {
        await credentials.disconnectSubscription(workspaceId, provider as SubscriptionProvider);
        invalidateModelsCache(workspaceId, provider);
        request.log.info(
          { event: 'credential.subscription_disconnected', workspaceId, provider },
          'Subscription disconnected',
        );
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof NoSubscriptionConnectedError) {
          return sendError(reply, 400, 'no_subscription', err.message);
        }
        if (err instanceof UnreadableCredentialError) {
          return sendError(reply, 500, 'credential_unreadable', 'The stored credential could not be read');
        }
        throw err;
      }
    },
  );
}

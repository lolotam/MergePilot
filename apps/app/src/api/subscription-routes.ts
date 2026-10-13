import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth/guard.js';
import { SubscriptionLogins } from '../credentials/subscription-login.js';
import { SubscriptionInputSchema, SubscriptionProviderSchema } from './contract-subscriptions.js';
import { sendError } from './helpers.js';
import { allow, invalidateModelsCache } from './provider-routes.js';
import type { DashboardApiDeps } from './routes.js';

export function registerSubscriptionRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  const logins = new SubscriptionLogins(deps.subscriptionLogin);
  app.addHook('onClose', async () => { logins.close(); });
  const guard = { preHandler: [requireRole('admin', deps.auth)] };
  const root = '/api/workspaces/:workspaceId/subscriptions';
  app.post(`${root}/:provider`, guard, async (request, reply) => {
    const { workspaceId, provider } = request.params as { workspaceId: string; provider: string };
    const parsed = SubscriptionProviderSchema.safeParse(provider);
    if (!parsed.success) return sendError(reply, 400, 'invalid_provider', 'Subscription login is unavailable for this provider');
    if (!allow(`${workspaceId}:subscription-login`, 5)) return sendError(reply, 429, 'rate_limited', 'Too many sign-in attempts; try again in a minute');
    try { return reply.send(logins.start(workspaceId, request.auth!.userId, parsed.data)); }
    catch { return sendError(reply, 429, 'rate_limited', 'Too many active sign-ins; try again later'); }
  });
  const sessionRoot = `${root}/sessions/:id`;
  app.get(sessionRoot, guard, async (request, reply) => {
    const { workspaceId, id } = request.params as { workspaceId: string; id: string };
    const attempt = logins.get(workspaceId, request.auth!.userId, id);
    if (!attempt) return sendError(reply, 404, 'login_not_found', 'Sign-in expired; start again');
    return reply.send(logins.snapshot(attempt));
  });
  app.post(`${sessionRoot}/input`, guard, async (request, reply) => {
    const { workspaceId, id } = request.params as { workspaceId: string; id: string };
    const attempt = logins.get(workspaceId, request.auth!.userId, id);
    if (!attempt) return sendError(reply, 404, 'login_not_found', 'Sign-in expired; start again');
    const parsed = SubscriptionInputSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'validation_error', 'Enter the authorization code');
    if (!logins.answer(attempt, parsed.data.promptId, parsed.data.value)) return sendError(reply, 409, 'stale_prompt', 'This sign-in step has already finished');
    return reply.send(logins.snapshot(attempt));
  });
  app.post(`${sessionRoot}/finish`, guard, async (request, reply) => {
    const { workspaceId, id } = request.params as { workspaceId: string; id: string };
    const attempt = logins.get(workspaceId, request.auth!.userId, id);
    if (!attempt) return sendError(reply, 404, 'login_not_found', 'Sign-in expired; start again');
    try {
      const ok = await logins.finish(attempt, (provider, credential) => deps.credentials.saveSubscription(workspaceId, provider, credential, request.auth!.userId));
      if (!ok) return sendError(reply, 409, 'login_pending', 'Complete sign-in before saving');
      invalidateModelsCache(workspaceId, attempt.state.provider);
      request.log.info({ event: 'credential.subscription_saved', workspaceId, provider: attempt.state.provider }, 'Subscription connected');
      return reply.send(logins.snapshot(attempt));
    } catch {
      return sendError(reply, 422, 'save_failed', 'Could not save the subscription; try again');
    }
  });
  app.delete(sessionRoot, guard, async (request, reply) => {
    const { workspaceId, id } = request.params as { workspaceId: string; id: string };
    const attempt = logins.get(workspaceId, request.auth!.userId, id);
    if (attempt) logins.cancel(attempt);
    return reply.status(204).send();
  });
}

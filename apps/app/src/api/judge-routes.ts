import type { FastifyInstance } from 'fastify';
import {
  isJevModel,
  isJudgeKeyOnlyProviderId,
  JUDGE_PROVIDER_IDS,
  JUDGE_PROVIDERS,
  jevModelIds,
  testJudgeConnection,
  type FetchLike,
} from '@mergepilot/engine';
import { requireRole } from '../auth/guard.js';
import { DASHBOARD_FETCH_LIMITS } from '../core/safe-fetch.js';
import { JudgeTestBodySchema, type JudgeProvidersResponse } from './contract.js';
import { sendError } from './helpers.js';
import { allow, redact, routeSignal, TEST_LIMIT } from './provider-routes.js';
import type { DashboardApiDeps } from './routes.js';

/**
 * Jev judge routes (ADR-0015): the fixed Jev-only model table for the settings card, and the
 * judge key test. A key typed before saving is used for this one call only: never stored, logged
 * or echoed.
 */
export function registerJudgeRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  const githubFetch = deps.githubFetch;
  // The judge endpoints are fixed preset URLs; tests inject their fetch the same way as presets.
  const presetFetch: FetchLike | undefined = githubFetch ? (input, init) => githubFetch(input, init) : undefined;

  app.get(
    '/api/workspaces/:workspaceId/judge/providers',
    { preHandler: [requireRole('member', deps.auth)] },
    async (_request, reply) => {
      const body: JudgeProvidersResponse = {
        providers: JUDGE_PROVIDER_IDS.map((id) => ({
          id,
          label: JUDGE_PROVIDERS[id].label,
          models: jevModelIds(id),
          keyOnly: isJudgeKeyOnlyProviderId(id),
        })),
      };
      return reply.status(200).send(body);
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/judge/test',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const parsed = JudgeTestBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, 'validation_error', 'Invalid judge test request');
      const { provider } = parsed.data;
      const model = parsed.data.model?.trim() || jevModelIds(provider)[0] || '';
      if (!isJevModel(provider, model)) {
        return sendError(reply, 400, 'judge_model_invalid', `${provider} offers only these Jev models: ${jevModelIds(provider).join(', ')}`);
      }
      if (!allow(`${workspaceId}:judge-test`, TEST_LIMIT)) {
        return sendError(reply, 429, 'rate_limited', `Rate limit exceeded: ${TEST_LIMIT} tests per minute per workspace`);
      }

      let apiKey = parsed.data.apiKey?.trim() ?? '';
      if (!apiKey) {
        if (!(await deps.store.getCredential(workspaceId, provider))) {
          return sendError(reply, 404, 'key_not_found', `No API key configured for provider "${provider}"`);
        }
        try {
          apiKey = (await deps.credentials.resolve(workspaceId, provider)).reveal();
        } catch {
          return sendError(reply, 404, 'key_not_found', `The stored key for "${provider}" could not be read`);
        }
      }

      const outcome = await testJudgeConnection(provider, apiKey, {
        model,
        ...(presetFetch ? { fetch: presetFetch } : {}),
        timeoutMs: DASHBOARD_FETCH_LIMITS.timeoutMs,
        signal: routeSignal(reply),
      });
      request.log.info(
        {
          event: 'judge.test',
          workspaceId,
          provider,
          model,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { code: outcome.code }),
          ms: outcome.ms,
        },
        outcome.ok ? 'Judge key tested' : 'Judge key test failed',
      );
      if (outcome.ok) return reply.status(200).send({ ok: true, ms: outcome.ms, model: outcome.model });
      return reply.status(200).send({ ok: false, code: outcome.code, message: redact(outcome.message, apiKey), ms: outcome.ms });
    },
  );
}

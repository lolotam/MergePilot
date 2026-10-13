import type { FastifyInstance } from 'fastify';
import { PRICE_SOURCES, type JudgeProviderId } from '@mergepilot/engine';
import { requireRole } from '../auth/guard.js';
import { judgeModelPrice, priceFields } from '../core/model-pricing.js';
import { findOverride, pickPrice, type StoredModelPrice } from '../core/price-types.js';
import type { WorkspaceSettings } from '../core/types.js';
import type { PricesResponse } from './contract.js';
import { sendError } from './helpers.js';
import type { DashboardApiDeps } from './routes.js';

type PricedModel = PricesResponse['models'][number];
type Role = PricedModel['role'];

/** Every model the workspace may call, in a stable order, with its role. */
function usedModels(settings: WorkspaceSettings): Array<{ provider: string; model: string; role: Role }> {
  const models: Array<{ provider: string; model: string; role: Role }> = [{ provider: settings.provider, model: settings.model, role: 'primary' }];
  if (settings.heavyModel) models.push({ provider: settings.heavyProvider ?? settings.provider, model: settings.heavyModel, role: 'heavy' });
  for (const f of settings.fallback ?? []) models.push({ provider: f.provider, model: f.model, role: 'fallback' });
  if (settings.judge?.enabled) {
    models.push({ provider: settings.judge.provider, model: settings.judge.model, role: 'judge' });
    for (const f of settings.judge.fallback) models.push({ provider: f.provider, model: f.model, role: 'judge-fallback' });
  }
  return models;
}

/** A review model: the manual price, then the catalog row (the repo file is not known here). */
function reviewModelPrice(
  rows: readonly StoredModelPrice[],
  overrides: WorkspaceSettings['priceOverrides'],
  provider: string,
  model: string,
): Pick<PricedModel, 'price' | 'source' | 'fetchedAt'> {
  const override = findOverride(overrides, provider, model);
  if (override) return { price: priceFields(override), source: 'override', fetchedAt: null };
  const row = pickPrice(rows, provider, model);
  if (row) return { price: priceFields(row), source: `catalog:${row.source}`, fetchedAt: row.fetchedAt.toISOString() };
  return { price: null, source: 'unknown', fetchedAt: null };
}

/**
 * GET /api/workspaces/:workspaceId/prices (member, ADR-0016): the price of every model the
 * workspace uses (primary, heavy, fallbacks, enabled judge and its fallbacks), where it came from,
 * and when each catalog source was last fetched.
 */
export function registerPricesRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  app.get('/api/workspaces/:workspaceId/prices', { preHandler: [requireRole('member', deps.auth)] }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const settings = await deps.store.getSettings(workspaceId);
    if (!settings) return sendError(reply, 404, 'not_configured', 'This workspace has no model settings yet');

    const models = usedModels(settings);
    const rows = await deps.store.listModelPrices(models);
    const overrides = settings.priceOverrides ?? [];
    const subscriptions = new Set((await deps.credentials.listKeys(workspaceId)).filter((key) => key.authMethod === 'subscription').map((key) => key.provider));
    const priced: PricedModel[] = models.map(({ provider, model, role }) => {
      const found =
        role === 'judge' || role === 'judge-fallback'
          ? (() => {
              const j = judgeModelPrice(rows, overrides, provider as JudgeProviderId, model);
              return { price: j.price, source: j.source, fetchedAt: j.fetchedAt ? j.fetchedAt.toISOString() : null };
            })()
           : subscriptions.has(provider as import('../core/types.js').KeyProvider)
             ? { price: { inputPerMTok: 0, outputPerMTok: 0 }, source: 'static' as const, fetchedAt: null }
             : reviewModelPrice(rows, overrides, provider, model);
      return { provider, model, role, ...found, overridden: found.source === 'override' };
    });

    const fetched = new Map((await deps.store.pricesFetchedAt()).map((f) => [f.source, f.fetchedAt.toISOString()]));
    const body: PricesResponse = {
      models: priced,
      sources: PRICE_SOURCES.map((source) => ({ source, fetchedAt: fetched.get(source) ?? null })),
    };
    return reply.status(200).send(body);
  });
}

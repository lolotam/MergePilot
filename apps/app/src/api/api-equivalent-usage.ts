import { costUsd, type TokenUsage } from '@mergepilot/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth/guard.js';
import type { Auth } from '../auth/auth.js';
import type { ApiEquivalentModel, ModelPriceStore, StoredModelPrice } from '../core/price-types.js';
import type { ApiEquivalentRunRow, ApiEquivalentRunUsage, AppStore, WorkspaceSettings } from '../core/types.js';
import { antigravityApiModel, apiEquivalentPrice, TOKEN_PLAN_API_PROVIDER } from '../worker/api-equivalent.js';

export interface ApiEquivalentUsage {
  monthUsd: number;
  totalUsd: number;
  reviews: number;
  averagePerReviewUsd: number;
  leftOut: number;
  byModel: ApiEquivalentModel[];
  monthStart: string;
}

export interface ApiEquivalentUsageDeps {
  auth: Auth;
  store: Pick<AppStore, 'listApiEquivalentRuns' | 'getSettings' | 'getModelPrice'>;
  now?: () => Date;
}

const SUBSCRIPTION_PROVIDERS = new Set(['openai', 'anthropic', 'xai', 'google-antigravity']);

/**
 * The catalog price of a model, looked up once per request: the card prices every retained run,
 * so thousands of old runs of the same model must not mean thousands of lookups. A model with no
 * price is remembered as missing, not looked up again.
 */
class PriceLookup implements Pick<ModelPriceStore, 'getModelPrice'> {
  private readonly pending = new Map<string, Promise<StoredModelPrice | null>>();
  private readonly store: Pick<ModelPriceStore, 'getModelPrice'>;

  constructor(store: Pick<ModelPriceStore, 'getModelPrice'>) {
    this.store = store;
  }

  getModelPrice(provider: string, model: string): Promise<StoredModelPrice | null> {
    const key = `${provider}\u0000${model}`;
    const found = this.pending.get(key);
    if (found) return found;
    const row = this.store.getModelPrice(provider, model);
    this.pending.set(key, row);
    return row;
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function storedModels(value: unknown): ApiEquivalentModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value.flatMap((item): ApiEquivalentModel[] => {
    const row = objectOf(item);
    if (!row || typeof row.provider !== 'string' || typeof row.model !== 'string') return [];
    const inputTokens = numberOf(row.inputTokens);
    const outputTokens = numberOf(row.outputTokens);
    const usd = numberOf(row.usd);
    return inputTokens === undefined || outputTokens === undefined || usd === undefined
      ? []
      : [{ provider: row.provider, model: row.model, inputTokens, outputTokens, usd }];
  });
  return models;
}

/** The run's own tokens, without the judge's: an absent cache count is zero, never missing. */
function withoutJudge(usage: ApiEquivalentRunUsage, judge: ApiEquivalentRunUsage | null): TokenUsage {
  return {
    inputTokens: Math.max(0, usage.inputTokens - (judge?.inputTokens ?? 0)),
    outputTokens: Math.max(0, usage.outputTokens - (judge?.outputTokens ?? 0)),
    cacheReadTokens: Math.max(0, (usage.cacheReadTokens ?? 0) - (judge?.cacheReadTokens ?? 0)),
    cacheWriteTokens: Math.max(0, (usage.cacheWriteTokens ?? 0) - (judge?.cacheWriteTokens ?? 0)),
  };
}

function apiChoice(provider: string, model: string, tokenPlan: boolean) {
  if (tokenPlan) {
    const apiProvider = TOKEN_PLAN_API_PROVIDER[provider];
    return apiProvider ? { provider: apiProvider, model } : undefined;
  }
  return provider === 'google-antigravity' ? antigravityApiModel(model) : { provider, model };
}

function addModel(models: Map<string, ApiEquivalentModel>, entry: ApiEquivalentModel): void {
  const key = `${entry.provider}\u0000${entry.model}`;
  const previous = models.get(key);
  models.set(key, previous
    ? {
        ...previous,
        inputTokens: previous.inputTokens + entry.inputTokens,
        outputTokens: previous.outputTokens + entry.outputTokens,
        usd: previous.usd + entry.usd,
      }
    : { ...entry });
}

/**
 * A token plan counts only when the catalog prices the plan model at a known $0 and the run's own
 * recorded pricing is $0 too: the rule `apiEquivalentPrice` applies (ADR-0024), so a plan a
 * workspace or a repository charges for real never gets an equivalent.
 */
async function pricesPlanAtZero(
  prices: PriceLookup,
  row: ApiEquivalentRunRow,
  pricing: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (!row.provider || !row.model) return false;
  const plan = await prices.getModelPrice(row.provider, row.model);
  if (!plan || plan.inputPerMTok !== 0 || plan.outputPerMTok !== 0) return false;
  return numberOf(pricing?.inputPerMTok) === 0 && numberOf(pricing?.outputPerMTok) === 0;
}

/**
 * The method switch the worker disclosed (ADR-0027): `fallbackFromMethod === 'subscription'` means
 * the run fell back from the subscription to API keys, so its subscription part cannot be told
 * apart from the paid one. Read from the stored run record.
 */
function fellBackFromSubscription(row: ApiEquivalentRunRow, pricing: Record<string, unknown> | undefined): boolean {
  const stored = objectOf(row);
  return stored?.fallbackFromMethod === 'subscription' || pricing?.fallbackFromMethod === 'subscription';
}

async function priceOldRun(
  prices: PriceLookup,
  settings: Pick<WorkspaceSettings, 'priceOverrides'>,
  row: ApiEquivalentRunRow,
  pricing: Record<string, unknown> | undefined,
  tokenPlan: boolean,
): Promise<ApiEquivalentModel | undefined> {
  if (!row.provider || !row.model || !row.usage) return undefined;
  const choice = apiChoice(row.provider, row.model, tokenPlan);
  if (!choice) return undefined;
  // The worker's own rule for the API price of a subscription or token-plan run (ADR-0024): the
  // workspace's manual price, then the catalog, never the repository's `budget.pricing`.
  const price = await apiEquivalentPrice(
    prices,
    settings,
    { includedInSubscription: !tokenPlan },
    { provider: row.provider, model: row.model },
    { inputPerMTok: numberOf(pricing?.inputPerMTok) ?? null, outputPerMTok: numberOf(pricing?.outputPerMTok) ?? null },
  );
  if (!price) return undefined;
  const usage = withoutJudge(row.usage, row.judgeUsage);
  return {
    ...choice,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usd: costUsd(usage, price.pricing),
  };
}

/**
 * Computes the display-only card from retained runs and current prices for older records (ADR-0047).
 *
 * A run counts when it has an equivalent: one it stored, or one priced now because it ran on a
 * subscription, on a token plan the catalog prices at $0, or on a subscription that fell back to
 * API keys. A run priced for real is neither counted nor left out; a run that should have had an
 * equivalent but has no price for it is left out.
 */
export async function apiEquivalentUsage(
  deps: ApiEquivalentUsageDeps,
  workspaceId: string,
  monthStart: Date,
): Promise<ApiEquivalentUsage> {
  const [rows, settings] = await Promise.all([
    deps.store.listApiEquivalentRuns(workspaceId),
    deps.store.getSettings(workspaceId),
  ]);
  const priceSettings = { priceOverrides: settings?.priceOverrides ?? [] };
  const prices = new PriceLookup(deps.store);
  const models = new Map<string, ApiEquivalentModel>();
  let monthUsd = 0;
  let totalUsd = 0;
  let reviews = 0;
  let leftOut = 0;

  for (const row of rows) {
    const pricing = objectOf(row.pricing);
    const storedUsd = numberOf(pricing?.apiEquivalentUsd);
    const tokenPlan = row.provider !== null && row.provider in TOKEN_PLAN_API_PROVIDER;
    const oldSubscription = pricing?.source === 'subscription';
    // A token plan counts only when the catalog prices it at $0 and the run's own price is $0.
    const planRun = tokenPlan && await pricesPlanAtZero(prices, row, pricing);
    // An older mixed run: it fell back from the subscription to API keys, so it should have had
    // an equivalent even though its own pricing is the real one. It is priced at the API price
    // of its own tokens when that price is known, and left out when it is not.
    const mixed = !oldSubscription
      && row.provider !== null
      && SUBSCRIPTION_PROVIDERS.has(row.provider)
      && fellBackFromSubscription(row, pricing);
    const shouldHaveEquivalent = oldSubscription || planRun || mixed;

    let entries: ApiEquivalentModel[] | undefined;
    let usd: number | undefined;
    if (storedUsd !== undefined) {
      usd = storedUsd;
      entries = storedModels(pricing?.apiEquivalentByModel);
      if (!entries && row.provider && row.model && row.usage) {
        // The stored amount stays as it is; its tokens are the run's own, without the judge's.
        const tokens = withoutJudge(row.usage, row.judgeUsage);
        entries = [{
          provider: row.provider,
          model: row.model,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          usd: storedUsd,
        }];
      }
    } else if (shouldHaveEquivalent) {
      const entry = await priceOldRun(prices, priceSettings, row, pricing, tokenPlan);
      if (entry) {
        usd = entry.usd;
        entries = [entry];
      }
    }

    if (usd === undefined) {
      // No price for a run that should have had one: it is left out of the card.
      if (shouldHaveEquivalent) leftOut++;
      continue;
    }
    reviews++;
    totalUsd += usd;
    if (row.createdAt >= monthStart) monthUsd += usd;
    for (const entry of entries ?? []) addModel(models, entry);
  }

  return {
    monthUsd,
    totalUsd,
    reviews,
    averagePerReviewUsd: reviews > 0 ? totalUsd / reviews : 0,
    leftOut,
    byModel: [...models.values()].sort((a, b) => b.usd - a.usd),
    monthStart: monthStart.toISOString(),
  };
}

export function registerApiEquivalentUsageRoute(app: FastifyInstance, deps: ApiEquivalentUsageDeps): void {
  app.get(
    '/api/workspaces/:workspaceId/usage/api-equivalent',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const now = deps.now ? deps.now() : new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      return reply.status(200).send(await apiEquivalentUsage(deps, workspaceId, monthStart));
    },
  );
}

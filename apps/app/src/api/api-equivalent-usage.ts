import { costUsd, type TokenUsage } from '@mergepilot/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth/guard.js';
import type { Auth } from '../auth/auth.js';
import type { ApiEquivalentModel, ModelPriceStore, StoredModelPrice } from '../core/price-types.js';
import type { ApiEquivalentRunRow, ApiEquivalentRunUsage, AppStore, WorkspaceSettings } from '../core/types.js';
import {
  antigravityApiModel, apiEquivalentPrice, SUBSCRIPTION_PROVIDERS, TOKEN_PLAN_API_PROVIDER,
} from '../worker/api-equivalent.js';

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

/** The providers whose runs can carry an equivalent: the subscriptions and the token plans. */
const CARD_PROVIDERS: readonly string[] = [...SUBSCRIPTION_PROVIDERS, ...Object.keys(TOKEN_PLAN_API_PROVIDER)];

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

/** A stored `subscriptionPart` (ADR-0047); undefined when it is null or not one. */
function storedPart(value: unknown): { usd: number; byModel: ApiEquivalentModel[] } | undefined {
  const part = objectOf(value);
  const usd = numberOf(part?.usd);
  if (usd === undefined || !Array.isArray(part?.byModel)) return undefined;
  const byModel = part.byModel.flatMap((item): ApiEquivalentModel[] => {
    const row = objectOf(item);
    if (!row || typeof row.provider !== 'string' || typeof row.model !== 'string') return [];
    const inputTokens = numberOf(row.inputTokens);
    const outputTokens = numberOf(row.outputTokens);
    const entryUsd = numberOf(row.usd);
    return inputTokens === undefined || outputTokens === undefined || entryUsd === undefined
      ? []
      : [{ provider: row.provider, model: row.model, inputTokens, outputTokens, usd: entryUsd }];
  });
  return { usd, byModel };
}

/**
 * The run's own tokens, without the judge's. Runs store only input and output tokens, so an older
 * run priced now leaves its cache tokens out: its figure is a lower bound (ADR-0047 §4).
 */
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
 * A subscription run priced when it ran: `subscription` since ADR-0024, `static` at $0 before it.
 * An API-key run is never priced at $0, so the $0 tells an old subscription run apart.
 */
function subscriptionPriced(row: ApiEquivalentRunRow, pricing: Record<string, unknown> | undefined): boolean {
  if (pricing?.source === 'subscription') return true;
  return pricing?.source === 'static'
    && row.provider !== null
    && SUBSCRIPTION_PROVIDERS.includes(row.provider)
    && numberOf(pricing.inputPerMTok) === 0
    && numberOf(pricing.outputPerMTok) === 0;
}

/** What a run adds to the card: an amount and its models, `leftOut`, or nothing. */
type RunShare = { usd: number; entries: ApiEquivalentModel[] } | 'leftOut' | undefined;

/**
 * Sorts a run into the card (ADR-0047). A stored subscription part (mixed or fallback run) or a
 * stored ADR-0024 equivalent is used as recorded. An older run that fell back from the subscription
 * to API keys, or from API keys to it, cannot be split, so it is left out. An older subscription or $0 token-plan run is
 * priced now from its tokens. A run priced for real is neither counted nor left out.
 */
async function shareOf(
  prices: PriceLookup,
  settings: Pick<WorkspaceSettings, 'priceOverrides'>,
  row: ApiEquivalentRunRow,
): Promise<RunShare> {
  const pricing = objectOf(row.pricing);
  if (pricing && 'subscriptionPart' in pricing) {
    const part = storedPart(pricing.subscriptionPart);
    if (!part) return 'leftOut';
    // A run whose subscription answered nothing used no subscription: neither counted nor left out.
    return part.byModel.length > 0 ? { usd: part.usd, entries: part.byModel } : undefined;
  }
  const tokenPlan = row.provider !== null && row.provider in TOKEN_PLAN_API_PROVIDER;
  const storedUsd = numberOf(pricing?.apiEquivalentUsd);
  if (storedUsd !== undefined) return { usd: storedUsd, entries: storedEntries(row, tokenPlan, storedUsd) };
  // An older run that switched methods either way (ADR-0027) cannot be split.
  const switched = (row.fallbackFromMethod === 'subscription' || row.fallbackFromMethod === 'api-key')
    && row.provider !== null && SUBSCRIPTION_PROVIDERS.includes(row.provider);
  // A token plan counts only when the catalog prices it at $0 and the run's own price is $0.
  const shouldHaveEquivalent = switched || subscriptionPriced(row, pricing)
    || (tokenPlan && await pricesPlanAtZero(prices, row, pricing));
  if (!shouldHaveEquivalent) return undefined;
  // No usage: a failed run made no call that answered, so there is nothing to price; a completed
  // one ran on a backend that reported none, so its tokens are unknown.
  if (!row.usage) return row.status === 'failed' ? undefined : 'leftOut';
  if (switched) return 'leftOut';
  const entry = await priceOldRun(prices, settings, row, pricing, tokenPlan);
  return entry ? { usd: entry.usd, entries: [entry] } : 'leftOut';
}

/**
 * The model split of a stored ADR-0024 equivalent: the run's own tokens, without the judge's, under
 * the API model that priced them, as a run priced now shows them.
 */
function storedEntries(row: ApiEquivalentRunRow, tokenPlan: boolean, usd: number): ApiEquivalentModel[] {
  if (!row.provider || !row.model || !row.usage) return [];
  const choice = apiChoice(row.provider, row.model, tokenPlan) ?? { provider: row.provider, model: row.model };
  const tokens = withoutJudge(row.usage, row.judgeUsage);
  return [{ ...choice, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, usd }];
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

/** Computes the display-only card from retained runs and current prices for older records (ADR-0047). */
export async function apiEquivalentUsage(
  deps: ApiEquivalentUsageDeps,
  workspaceId: string,
  monthStart: Date,
): Promise<ApiEquivalentUsage> {
  const [rows, settings] = await Promise.all([
    deps.store.listApiEquivalentRuns(workspaceId, CARD_PROVIDERS),
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
    const share = await shareOf(prices, priceSettings, row);
    if (share === 'leftOut') leftOut++;
    if (share === undefined || share === 'leftOut') continue;
    reviews++;
    totalUsd += share.usd;
    if (row.createdAt >= monthStart) monthUsd += share.usd;
    for (const entry of share.entries) addModel(models, entry);
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

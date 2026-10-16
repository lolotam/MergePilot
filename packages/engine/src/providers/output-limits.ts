/**
 * The most output tokens one call to a model may ask for, from pi-ai's bundled model catalogs —
 * the same `maxTokens` the subscription path caps at (`subscriptionOutputTokens`). Only providers
 * whose MergePilot id names the same API as a pi-ai catalog are mapped; any other provider or an
 * unlisted model is unknown, and its calls keep the budget they ask for (ADR-0033).
 */
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { xiaomiProvider } from '@earendil-works/pi-ai/providers/xiaomi';
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai';

type Catalog = () => { getModels(): ReadonlyArray<{ id: string; maxTokens: number }> };

const CATALOGS: Readonly<Record<string, Catalog>> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: googleProvider,
  xai: xaiProvider,
  deepseek: deepseekProvider,
  nvidia: nvidiaProvider,
  openrouter: openrouterProvider,
  'vercel-gateway': vercelAIGatewayProvider,
  'opencode-zen': opencodeProvider,
  'opencode-go': opencodeGoProvider,
  zai: zaiProvider,
  xiaomi: xiaomiProvider,
};

const limits = new Map<string, ReadonlyMap<string, number>>();

/** The model's catalog output limit, or undefined when the provider or the model is not listed. */
export function knownMaxOutputTokens(provider: string, model: string): number | undefined {
  const catalog = CATALOGS[provider];
  if (!catalog) return undefined;
  let byModel = limits.get(provider);
  if (!byModel) {
    byModel = new Map(catalog().getModels().map((entry) => [entry.id, entry.maxTokens]));
    limits.set(provider, byModel);
  }
  const limit = byModel.get(model);
  return limit !== undefined && limit > 0 ? limit : undefined;
}

/**
 * The answer budget that keeps `requested` (answer + thinking headroom) within `limit`. The
 * headroom is kept whole; when it alone reaches the limit, cutting the answer cannot help, so the
 * answer is left as asked.
 */
export function answerTokensWithin(limit: number | undefined, answerTokens: number, requested: number): number {
  if (limit === undefined || requested <= limit) return answerTokens;
  const headroom = requested - answerTokens;
  return headroom < limit ? limit - headroom : answerTokens;
}

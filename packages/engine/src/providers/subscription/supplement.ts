import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import type { PiSubscriptionProvider } from '../../credentials/subscription.js';
import type { CatalogModel } from '../catalog-types.js';
import { subscriptionProvider } from './auth.js';

/** Ids the OpenAI API lists that are not chat models. Shared with the API-key catalog. */
export const OPENAI_NOT_CHAT =
  /embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|instruct|computer-use|sora|davinci|babbage/i;

/** GPT-5 and later, and Codex ids: the families the Codex sign-in can serve. Older GPT-4 and o-series ids stay out. */
const CODEX_FAMILY = /^(gpt-(?:[5-9]|\d{2,})|codex-)/;

type PiModel = ReturnType<ReturnType<typeof subscriptionProvider>['getModels']>[number];

function isSupplementaryId(id: string): boolean {
  return CODEX_FAMILY.test(id) && !OPENAI_NOT_CHAT.test(id);
}

/**
 * A Codex model the bundled pi-ai catalog does not list yet, built from the bundled model that takes the
 * most thinking efforts (so a saved `off` stays valid), then has the largest context window: it keeps that
 * model's protocol, base URL and limits and only swaps the id.
 * Undefined for other providers and for ids outside the Codex families. The ChatGPT backend still
 * decides whether the sign-in may use the model; a refusal reaches the caller as an `LlmFailure`.
 */
export function supplementaryModel(provider: PiSubscriptionProvider, id: string): PiModel | undefined {
  if (provider !== 'openai' || !isSupplementaryId(id)) return undefined;
  const bundled = subscriptionProvider('openai').getModels();
  const rank = (model: PiModel): [number, number] => [getSupportedThinkingLevels(model).length, model.contextWindow];
  const template = bundled.reduce<PiModel | undefined>((best, model) => {
    if (!best) return model;
    const [levels, window] = rank(model);
    const [bestLevels, bestWindow] = rank(best);
    return levels > bestLevels || (levels === bestLevels && window > bestWindow) ? model : best;
  }, undefined);
  return template ? { ...template, id, name: id } : undefined;
}

/**
 * Codex models OpenAI released after the bundled pi-ai catalog, listed for every Codex sign-in with no API key
 * needed (GPT-6.2 Astra and Sol, 2026-11-17). Drop an id once the bundled catalog lists it.
 */
export const CODEX_EXTRA_MODEL_IDS: readonly string[] = ['gpt-6.2-astra', 'gpt-6.2-sol'];

/** The bundled catalog with `CODEX_EXTRA_MODEL_IDS` added for Codex; other providers are returned as is. */
export function withCodexExtras(provider: PiSubscriptionProvider, bundled: readonly CatalogModel[]): CatalogModel[] {
  if (provider !== 'openai') return [...bundled];
  return supplementCatalog(bundled, CODEX_EXTRA_MODEL_IDS.map((id) => ({ id, name: id, efforts: [] })));
}

/** The bundled Codex catalog plus the Codex-family models the workspace's OpenAI API key also lists. */
export function supplementCatalog(bundled: readonly CatalogModel[], apiModels: readonly CatalogModel[]): CatalogModel[] {
  const known = new Set(bundled.map((model) => model.id));
  const extra: CatalogModel[] = [];
  for (const { id } of apiModels) {
    if (known.has(id)) continue;
    const model = supplementaryModel('openai', id);
    if (!model) continue;
    known.add(id);
    extra.push({ id, name: id, efforts: getSupportedThinkingLevels(model), contextWindow: model.contextWindow });
  }
  return [...bundled, ...extra];
}

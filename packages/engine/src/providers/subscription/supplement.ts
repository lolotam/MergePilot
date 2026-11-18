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
 * A Codex model the bundled pi-ai catalog does not list yet, built from the bundled model with the
 * largest context window: it keeps that model's protocol, base URL and limits and only swaps the id.
 * Undefined for other providers and for ids outside the Codex families. The ChatGPT backend still
 * decides whether the sign-in may use the model; a refusal reaches the caller as an `LlmFailure`.
 */
export function supplementaryModel(provider: PiSubscriptionProvider, id: string): PiModel | undefined {
  if (provider !== 'openai' || !isSupplementaryId(id)) return undefined;
  const bundled = subscriptionProvider('openai').getModels();
  const template = bundled.reduce<PiModel | undefined>(
    (best, model) => (!best || model.contextWindow > best.contextWindow ? model : best),
    undefined,
  );
  return template ? { ...template, id, name: id } : undefined;
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

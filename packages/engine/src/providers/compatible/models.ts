/**
 * Model list of an OpenAI-compatible endpoint. Ported from the owner's Browser-controle
 * extension (`listCompatibleModels` in `src/providers/openai-compatible.js`).
 */
import { FALLBACK_EFFORTS, minimaxTakesEffort } from '../effort.js';
import { bearerHeaders, failureFromResponse, failureFromThrown, type FetchLike, type KeyInput } from '../http.js';
import type { ApiProviderId } from '../ids.js';
import { chatModelsFor, providerEntry, resolveBaseUrl } from '../registry.js';
import type { CatalogModel } from '../catalog-types.js';

/** Gateways list image, video and embedding models next to chat models. */
const NON_CHAT_TYPES = new Set([
  'embedding',
  'image',
  'video',
  'reranking',
  'speech',
  'transcription',
  'realtime',
  'evaluation',
]);
/** Gateways that type every model: only `type: 'language'` entries are chat models there. */
const LANGUAGE_TYPED: ReadonlySet<ApiProviderId> = new Set<ApiProviderId>(['vercel-gateway']);
/** Gemini and NVIDIA list embedding and rerank models without a type field. */
const NON_CHAT_ID = /embed|rerank/i;
/** OpenRouter and Vercel `supported_parameters` that mean the model takes a reasoning setting. */
const REASONING_PARAMS = ['reasoning', 'reasoning_effort', 'include_reasoning'];

interface RawCompatibleModel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  supported_parameters?: unknown;
  reasoning_options?: unknown;
}

export interface ListCompatibleOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** Effort values a `reasoning_effort` request can carry (`off` = send nothing). */
const SENDABLE_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Vercel lists the reasoning controls each model really takes in `reasoning_options`
 * (`toggle`, `budget_tokens`, `effort` with its allowed values); `supported_parameters` only
 * says the model reasons. Only the listed effort values are offered, so a review never sends one
 * the model rejects. Models with a toggle or token budget only get none: nothing is sent and the
 * model keeps its own default. Undefined when the entry has no `reasoning_options`.
 */
function effortsFromReasoningOptions(raw: RawCompatibleModel): string[] | undefined {
  if (!Array.isArray(raw.reasoning_options)) return undefined;
  for (const option of raw.reasoning_options as unknown[]) {
    const entry = option && typeof option === 'object' ? (option as Record<string, unknown>) : {};
    if (entry.type !== 'effort' || !Array.isArray(entry.values)) continue;
    const values = (entry.values as unknown[]).filter(
      (v): v is string => typeof v === 'string' && SENDABLE_EFFORTS.has(v),
    );
    return values.length > 0 ? ['off', ...values] : [];
  }
  return [];
}

/**
 * The efforts a model really takes. A MiniMax model that does not read `reasoning_effort`
 * ignores it, so it is offered none: a depth that changes nothing is not a choice to offer.
 */
function effortsFor(provider: ApiProviderId, raw: RawCompatibleModel, id: string): string[] {
  const style = providerEntry(provider).thinkingStyle;
  if (style === 'minimax' && !minimaxTakesEffort(id)) return [];
  if (provider === 'vercel-gateway') {
    const listed = effortsFromReasoningOptions(raw);
    if (listed) return listed;
  }
  // OpenRouter and Vercel say per model whether it takes reasoning; other lists do not say.
  if (Array.isArray(raw.supported_parameters)) {
    const params = raw.supported_parameters as unknown[];
    return REASONING_PARAMS.some((p) => params.includes(p)) ? [...FALLBACK_EFFORTS[style]] : [];
  }
  return [...FALLBACK_EFFORTS[style]];
}

function contextOf(raw: RawCompatibleModel): number | undefined {
  const value = raw.context_length ?? raw.context_window;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

export async function listCompatibleModels(
  provider: ApiProviderId,
  apiKey: KeyInput,
  options: ListCompatibleOptions = {},
): Promise<CatalogModel[]> {
  const url = `${resolveBaseUrl(provider, options.baseUrl)}/models`;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const get = async (withKey: boolean): Promise<Response> => {
    try {
      return await doFetch(url, {
        headers: withKey ? bearerHeaders(apiKey) : {},
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw failureFromThrown(error, provider, apiKey, options.signal);
    }
  };

  let res = await get(true);
  // OpenRouter and some gateways publish their list but reject an invalid key; the list
  // still loads so the user can pick a model, and the connection test reports the key.
  if (res.status === 401 || res.status === 403) {
    const publicList = await get(false);
    if (publicList.ok) res = publicList;
  }
  if (!res.ok) throw await failureFromResponse(res, provider, apiKey);

  const body = (await res.json()) as { data?: unknown; models?: unknown };
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const models = (list as RawCompatibleModel[])
    .map((raw) => ({ raw, id: String(raw.id ?? raw.name ?? '').replace(/^models\//, '') }))
    .filter(({ raw, id }) => id && !NON_CHAT_TYPES.has(String(raw.type)) && !NON_CHAT_ID.test(id))
    .filter(({ raw }) => !LANGUAGE_TYPED.has(provider) || raw.type === 'language')
    .map(({ raw, id }): CatalogModel => {
      const contextWindow = contextOf(raw);
      return {
        id,
        name: typeof raw.name === 'string' && raw.name && !raw.name.startsWith('models/') ? raw.name : id,
        efforts: effortsFor(provider, raw, id),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    });
  return chatModelsFor(provider, models);
}

/**
 * Model catalog: the models a customer's key can use, with the thinking efforts each one takes.
 * Failures are `LlmFailure`s whose messages never contain the key (Gemini's key travels in the
 * `x-goog-api-key` header, never in the URL).
 */
import { type CatalogModel, sortUnique } from './catalog-types.js';
import { listCompatibleModels } from './compatible/models.js';
import { FALLBACK_EFFORTS } from './effort.js';
import { failureFromResponse, failureFromThrown, keyValue, type FetchLike, type KeyInput } from './http.js';
import type { ApiProviderId } from './ids.js';
import { providerEntry, resolveBaseUrl } from './registry.js';

export type { CatalogModel } from './catalog-types.js';

export interface ListModelsOptions {
  /** Required for `custom`; overrides a preset's URL otherwise. */
  baseUrl?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** Pages followed at most, so a misbehaving API cannot loop forever. */
const MAX_PAGES = 10;
const ANTHROPIC_VERSION = '2023-06-01';

async function getJson(
  provider: ApiProviderId,
  url: string,
  headers: Record<string, string>,
  key: KeyInput,
  options: ListModelsOptions,
): Promise<unknown> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(url, { headers, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    throw failureFromThrown(error, provider, key, options.signal);
  }
  if (!res.ok) throw await failureFromResponse(res, provider, key);
  return res.json();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function entry(id: string, name: unknown, efforts: string[], contextWindow: number | undefined): CatalogModel {
  return {
    id,
    name: typeof name === 'string' && name ? name : id,
    efforts,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

const ANTHROPIC_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Efforts from the Models API `capabilities` when present, else the Anthropic fallback table. */
function anthropicEfforts(capabilities: unknown): string[] {
  const caps = record(capabilities);
  const effort = record(caps.effort);
  if (effort.supported === true) {
    const levels = ANTHROPIC_LEVELS.filter((level) => record(effort[level]).supported === true);
    if (levels.length > 0) return ['off', ...levels];
  }
  if (record(caps.thinking).supported === false) return [];
  return [...FALLBACK_EFFORTS.anthropic];
}

async function listAnthropic(key: KeyInput, options: ListModelsOptions): Promise<CatalogModel[]> {
  const base = resolveBaseUrl('anthropic', options.baseUrl);
  const headers = { 'x-api-key': keyValue(key) ?? '', 'anthropic-version': ANTHROPIC_VERSION };
  const out: CatalogModel[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = `limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const body = record(await getJson('anthropic', `${base}/models?${query}`, headers, key, options));
    const data = Array.isArray(body.data) ? (body.data as unknown[]) : [];
    for (const item of data.map(record)) {
      if (typeof item.id !== 'string') continue;
      out.push(entry(item.id, item.display_name, anthropicEfforts(item.capabilities), positive(item.max_input_tokens)));
    }
    if (body.has_more !== true || typeof body.last_id !== 'string') break;
    after = body.last_id;
  }
  return out;
}

const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-|codex-)/;
const OPENAI_NOT_CHAT =
  /embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|instruct|computer-use|sora|davinci|babbage/i;
const OPENAI_REASONING = /^(o\d|gpt-5|codex-)/;

async function listOpenAI(key: KeyInput, options: ListModelsOptions): Promise<CatalogModel[]> {
  const base = resolveBaseUrl('openai', options.baseUrl);
  const value = keyValue(key);
  const body = record(
    await getJson('openai', `${base}/models`, value ? { Authorization: `Bearer ${value}` } : {}, key, options),
  );
  const data = Array.isArray(body.data) ? (body.data as unknown[]) : [];
  return data
    .map(record)
    .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === 'string')
    .filter((m) => OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
    .map((m) => entry(m.id, m.id, OPENAI_REASONING.test(m.id) ? [...FALLBACK_EFFORTS.reasoning_effort] : [], undefined));
}

const GEMINI_NOT_CHAT = /embed|aqa|imagen|veo|tts|image-generation/i;
const GEMINI_THINKING_FAMILY = /^gemini-(?:2\.5|[3-9])/;

function geminiEfforts(id: string, thinking: unknown): string[] {
  if (thinking === false) return [];
  if (thinking === true || GEMINI_THINKING_FAMILY.test(id)) return [...FALLBACK_EFFORTS.gemini];
  return [];
}

async function listGemini(key: KeyInput, options: ListModelsOptions): Promise<CatalogModel[]> {
  const base = resolveBaseUrl('gemini', options.baseUrl);
  const headers = { 'x-goog-api-key': keyValue(key) ?? '' };
  const out: CatalogModel[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = `pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const body = record(await getJson('gemini', `${base}/models?${query}`, headers, key, options));
    const models = Array.isArray(body.models) ? (body.models as unknown[]) : [];
    for (const item of models.map(record)) {
      if (typeof item.name !== 'string') continue;
      const id = item.name.replace(/^models\//, '');
      const methods = Array.isArray(item.supportedGenerationMethods) ? (item.supportedGenerationMethods as unknown[]) : [];
      if (!methods.includes('generateContent') || GEMINI_NOT_CHAT.test(id)) continue;
      out.push(entry(id, item.displayName, geminiEfforts(id, item.thinking), positive(item.inputTokenLimit)));
    }
    if (typeof body.nextPageToken !== 'string' || !body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out;
}

/**
 * Lists the chat models `apiKey` can use on `provider`, sorted by id and de-duplicated.
 * Efforts come from the provider's response when it says, else from FALLBACK_EFFORTS by the
 * provider's thinking style.
 */
export async function listModels(
  provider: ApiProviderId,
  apiKey: KeyInput,
  options: ListModelsOptions = {},
): Promise<CatalogModel[]> {
  let models: CatalogModel[];
  if (provider === 'anthropic') models = await listAnthropic(apiKey, options);
  else if (provider === 'openai') models = await listOpenAI(apiKey, options);
  else if (provider === 'gemini') models = await listGemini(apiKey, options);
  else if (providerEntry(provider).kind === 'openai-compatible') models = await listCompatibleModels(provider, apiKey, options);
  else throw new Error(`No model catalog for provider ${String(provider)}`);
  return sortUnique(models);
}

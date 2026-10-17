/**
 * The models a Google Antigravity account can use (ADR-0032 §9): `fetchAvailableModels`, cached
 * per Cloud Code Assist project for four hours. A failed refresh keeps the last list that worked,
 * and with none a static list is returned, so the model picker still opens; a real access problem
 * then shows on the connection test or the review as an `LlmFailure`.
 */
import { sortUnique, type CatalogModel } from '../../catalog-types.js';
import { FALLBACK_EFFORTS } from '../../effort.js';
import { antigravityHeaders } from './config.js';
import { discardBody, fetchWithHosts, readJson, type FetchFn } from './transport.js';

export const ANTIGRAVITY_MODELS_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/** Shown when the account's list cannot be read. Ids as the Antigravity clients name them. */
export const ANTIGRAVITY_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'gemini-3.1-pro',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gpt-oss-120b',
];

const CHAT_MODEL = /^(?:gemini-|claude-|gpt-oss-)/;
const NOT_CHAT = /image|embed|tts|audio|-lite-preview-tab/i;
const CLAUDE_EFFORTS = ['off', 'low', 'medium', 'high'];

export function antigravityEfforts(model: string): string[] {
  if (model.startsWith('claude-')) return [...CLAUDE_EFFORTS];
  if (/^gemini-(?:2\.5|[3-9])/.test(model)) return [...FALLBACK_EFFORTS.gemini];
  return [];
}

function catalogEntry(id: string, name?: unknown, contextWindow?: unknown): CatalogModel {
  return {
    id,
    name: typeof name === 'string' && name ? name : id,
    efforts: antigravityEfforts(id),
    ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
  };
}

/** `models` is a map keyed by id in the answers seen so far; an array of entries is accepted too. */
export function parseAvailableModels(body: unknown): CatalogModel[] {
  const models = body && typeof body === 'object' ? (body as { models?: unknown }).models : undefined;
  const entries: Array<[string, Record<string, unknown>]> = [];
  if (Array.isArray(models)) {
    for (const item of models) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = [record.id, record.model, record.name].find((value): value is string => typeof value === 'string');
      if (id) entries.push([id.replace(/^models\//, ''), record]);
    }
  } else if (models && typeof models === 'object') {
    for (const [id, value] of Object.entries(models)) entries.push([id, value && typeof value === 'object' ? (value as Record<string, unknown>) : {}]);
  }
  return sortUnique(entries
    .filter(([id]) => CHAT_MODEL.test(id) && !NOT_CHAT.test(id))
    .map(([id, record]) => catalogEntry(id, record.displayName, record.maxTokens ?? record.inputTokenLimit)));
}

export function staticAntigravityModels(): CatalogModel[] {
  return sortUnique(ANTIGRAVITY_STATIC_MODELS.map((id) => catalogEntry(id)));
}

const cache = new Map<string, { expiresAt: number; models: CatalogModel[] }>();
const lastGood = new Map<string, CatalogModel[]>();

/** Test helper. */
export function resetAntigravityModelCache(): void {
  cache.clear();
  lastGood.clear();
}

function remember(projectId: string, models: CatalogModel[], now: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  if (lastGood.size >= CACHE_MAX_ENTRIES) lastGood.clear();
  cache.set(projectId, { expiresAt: now + ANTIGRAVITY_MODELS_TTL_MS, models });
  lastGood.set(projectId, models);
}

export interface ListAntigravityOptions {
  fetch?: FetchFn;
  signal?: AbortSignal;
  now?: () => number;
}

export async function listAntigravityModels(
  credential: { access: string; projectId?: unknown },
  options: ListAntigravityOptions = {},
): Promise<CatalogModel[]> {
  const projectId = typeof credential.projectId === 'string' ? credential.projectId : '';
  const now = (options.now ?? Date.now)();
  const cached = cache.get(projectId);
  if (projectId && cached && cached.expiresAt > now) return cached.models;
  let models: CatalogModel[] | undefined;
  try {
    models = await fetchModels(credential.access, projectId, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // No answer or an unreadable one: the fallback below, like a refusal.
  }
  if (!models || models.length === 0) return lastGood.get(projectId) ?? staticAntigravityModels();
  if (projectId) remember(projectId, models, now);
  return models;
}

/** The account's chat models, or undefined when Google refused the request. */
async function fetchModels(access: string, projectId: string, options: ListAntigravityOptions): Promise<CatalogModel[] | undefined> {
  const response = await fetchWithHosts(options.fetch ?? fetch, 'fetchAvailableModels', {
    method: 'POST',
    headers: antigravityHeaders(access),
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    await discardBody(response);
    return undefined;
  }
  return parseAvailableModels(await readJson(response, 'Cloud Code Assist fetchAvailableModels'));
}

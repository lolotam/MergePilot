/**
 * Public model price lists (ADR-0016). Every URL is a fixed constant and no key is ever sent.
 * The responses are untrusted data: each parser keeps only well-formed entries with prices that
 * are finite, ≥ 0 and ≤ MAX_PRICE_PER_MTOK USD per million tokens, and drops anything else.
 */

export const PRICE_SOURCES = ['openrouter', 'vercel', 'models.dev'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const PRICE_SOURCE_URLS: Readonly<Record<PriceSource, string>> = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  vercel: 'https://ai-gateway.vercel.sh/v1/models',
  'models.dev': 'https://models.dev/api.json',
};

/**
 * Our provider id → its models.dev provider key, for every provider without its own price API.
 * `custom`, `claude-code` and the judge's `typesafe` have no source: only a manual price applies.
 */
export const MODELS_DEV_PROVIDER_KEYS: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  nvidia: 'nvidia',
  'opencode-zen': 'opencode',
  'opencode-go': 'opencode-go',
  zai: 'zai',
  'zai-coding': 'zai-coding-plan',
  xiaomi: 'xiaomi',
  'xiaomi-token-plan': 'xiaomi-token-plan-sgp',
  'xiaomi-token-plan-cn': 'xiaomi-token-plan-cn',
  minimax: 'minimax',
  'minimax-coding-plan': 'minimax-coding-plan',
};

/** Prices above this many USD per million tokens are treated as garbage and dropped. */
export const MAX_PRICE_PER_MTOK = 1000;

/** One model's price in USD per million tokens, from one source. */
export interface PriceEntry {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
  source: PriceSource;
}

const MAX_MODEL_ID_LENGTH = 200;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * A price in USD per MTok: `scale` turns the source's unit into per-MTok (1e6 for per-token
 * prices). Undefined for anything that is not a finite number in range; "-1" (dynamic pricing)
 * fails the range check like every negative value.
 */
function perMTok(value: unknown, scale: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  // numeric(12,6) in the database: round away floating noise such as 2.9999999999999996.
  const scaled = Math.round(n * scale * 1e6) / 1e6;
  return scaled >= 0 && scaled <= MAX_PRICE_PER_MTOK ? scaled : undefined;
}

interface RawPrices {
  input: unknown;
  output: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
}

/** The entry, or undefined when a present price is invalid or input/output is missing. */
function toEntry(provider: string, model: unknown, raw: RawPrices, scale: number, source: PriceSource): PriceEntry | undefined {
  if (typeof model !== 'string' || !model.trim() || model.length > MAX_MODEL_ID_LENGTH) return undefined;
  const input = perMTok(raw.input, scale);
  const output = perMTok(raw.output, scale);
  if (input === undefined || output === undefined) return undefined;
  const optional = (value: unknown): number | undefined | null =>
    value === undefined || value === null ? undefined : (perMTok(value, scale) ?? null);
  const cacheRead = optional(raw.cacheRead);
  const cacheWrite = optional(raw.cacheWrite);
  if (cacheRead === null || cacheWrite === null) return undefined;
  return {
    provider,
    model,
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cacheRead !== undefined ? { cacheReadPerMTok: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWritePerMTok: cacheWrite } : {}),
    source,
  };
}

/** Keeps the first entry per (provider, model): one row per key in the price table. */
function unique(entries: Iterable<PriceEntry | undefined>): PriceEntry[] {
  const seen = new Set<string>();
  const out: PriceEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    const key = `${entry.provider}\u0000${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function dataList(json: unknown): unknown[] {
  const data = record(json)?.data;
  return Array.isArray(data) ? data : [];
}

/** OpenRouter `{data: [{id, pricing: {prompt, completion, input_cache_read?, input_cache_write?}}]}`, USD per token. */
export function parseOpenRouterPrices(json: unknown): PriceEntry[] {
  return unique(
    dataList(json).map((item) => {
      const model = record(item);
      const pricing = record(model?.pricing);
      if (!model || !pricing) return undefined;
      const raw = { input: pricing.prompt, output: pricing.completion, cacheRead: pricing.input_cache_read, cacheWrite: pricing.input_cache_write };
      return toEntry('openrouter', model.id, raw, 1e6, 'openrouter');
    }),
  );
}

/** Vercel AI Gateway `{data: [{id, pricing?: {input, output, input_cache_read?, input_cache_write?}}]}`, USD per token. */
export function parseVercelPrices(json: unknown): PriceEntry[] {
  return unique(
    dataList(json).map((item) => {
      const model = record(item);
      const pricing = record(model?.pricing);
      if (!model || !pricing) return undefined;
      const raw = { input: pricing.input, output: pricing.output, cacheRead: pricing.input_cache_read, cacheWrite: pricing.input_cache_write };
      return toEntry('vercel-gateway', model.id, raw, 1e6, 'vercel');
    }),
  );
}

/**
 * models.dev `{<providerKey>: {models: {<modelId>: {id, cost?: {input, output, cache_read?, cache_write?}}}}}`,
 * already USD per MTok. Only the mapped provider keys are read; `tiers` and `context_over_200k`
 * are ignored (the base price applies).
 */
export function parseModelsDevPrices(json: unknown, mapping: Readonly<Record<string, string>>): PriceEntry[] {
  const catalog = record(json);
  if (!catalog) return [];
  const entries: Array<PriceEntry | undefined> = [];
  for (const [provider, key] of Object.entries(mapping)) {
    const models = record(record(catalog[key])?.models);
    if (!models) continue;
    for (const [modelKey, value] of Object.entries(models)) {
      const model = record(value);
      const cost = record(model?.cost);
      if (!model || !cost) continue;
      const id = typeof model.id === 'string' && model.id.trim() ? model.id : modelKey;
      const raw = { input: cost.input, output: cost.output, cacheRead: cost.cache_read, cacheWrite: cost.cache_write };
      entries.push(toEntry(provider, id, raw, 1, 'models.dev'));
    }
  }
  return unique(entries);
}

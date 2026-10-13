/**
 * Fetches the public price lists (ADR-0016). Each source has its own timeout and body cap, and
 * one source failing never affects the others. No key or auth header is sent; error texts are
 * short fixed strings, never a response body.
 */
import type { FetchLike } from '../providers/http.js';
import {
  MODELS_DEV_PROVIDER_KEYS,
  PRICE_SOURCE_URLS,
  PRICE_SOURCES,
  parseModelsDevPrices,
  parseOpenRouterPrices,
  parseVercelPrices,
  type PriceEntry,
  type PriceSource,
} from './sources.js';

export const PRICE_FETCH_TIMEOUT_MS = 30_000;
/** models.dev is about 5.5 MB; anything past this is refused while the body is read. */
export const PRICE_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

export interface PriceSourceResult {
  source: PriceSource;
  ok: boolean;
  count: number;
  ms: number;
  error?: string | undefined;
}

export interface PriceCatalog {
  entries: PriceEntry[];
  sources: PriceSourceResult[];
}

export interface FetchPriceCatalogOptions {
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  /** Per source (default 30 s), covering the headers and the whole body. */
  timeoutMs?: number | undefined;
  /** Per response (default 25 MB). */
  maxBytes?: number | undefined;
}

class PriceFetchError extends Error {}

const PARSERS: Record<PriceSource, (json: unknown) => PriceEntry[]> = {
  openrouter: parseOpenRouterPrices,
  vercel: parseVercelPrices,
  'models.dev': (json) => parseModelsDevPrices(json, MODELS_DEV_PROVIDER_KEYS),
};

/** Resolves when the signal aborts; never rejects. */
function aborted(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

/** Reads the body up to `maxBytes`, stopping as soon as the cap is passed or the signal aborts. */
async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PriceFetchError('response too large');
  const reader = res.body?.getReader();
  if (!reader) return '';
  const stop = aborted(signal);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stop]);
      if (next === 'aborted') throw signal.reason ?? new DOMException('aborted', 'AbortError');
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) throw new PriceFetchError('response too large');
      chunks.push(next.value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** A short, body-free reason for the log and the maintenance record. */
function describeFailure(error: unknown, caller: AbortSignal | undefined, timeout: AbortSignal): string {
  if (error instanceof PriceFetchError) return error.message;
  if (caller?.aborted) return 'aborted';
  if (timeout.aborted || (error instanceof Error && error.name === 'TimeoutError')) return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  if (error instanceof TypeError) return 'network error';
  return 'fetch failed';
}

async function fetchSource(source: PriceSource, options: FetchPriceCatalogOptions): Promise<{ result: PriceSourceResult; entries: PriceEntry[] }> {
  const started = Date.now();
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PRICE_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    // A fetch that ignores the signal still loses the race against it.
    const res = await Promise.race([
      doFetch(PRICE_SOURCE_URLS[source], { method: 'GET', headers: { accept: 'application/json' }, signal }),
      aborted(signal),
    ]);
    if (res === 'aborted') throw signal.reason ?? new DOMException('aborted', 'AbortError');
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      throw new PriceFetchError(`HTTP ${res.status}`);
    }
    const text = await readCapped(res, options.maxBytes ?? PRICE_MAX_RESPONSE_BYTES, signal);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PriceFetchError('invalid JSON');
    }
    const entries = PARSERS[source](json);
    // An empty list is a format change or an outage page, not "every model is gone": treat it as
    // a failure so the stored prices of this source are kept.
    if (entries.length === 0) throw new PriceFetchError('no prices found');
    return { result: { source, ok: true, count: entries.length, ms: Date.now() - started }, entries };
  } catch (error) {
    const reason = describeFailure(error, options.signal, timeout);
    return { result: { source, ok: false, count: 0, ms: Date.now() - started, error: reason }, entries: [] };
  }
}

/** Fetches every source in parallel; `sources` lists them in PRICE_SOURCES order. */
export async function fetchPriceCatalog(options: FetchPriceCatalogOptions = {}): Promise<PriceCatalog> {
  const results = await Promise.all(PRICE_SOURCES.map((source) => fetchSource(source, options)));
  return { entries: results.flatMap((r) => r.entries), sources: results.map((r) => r.result) };
}

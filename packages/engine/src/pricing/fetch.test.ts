import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../providers/http.js';
import { fetchPriceCatalog } from './fetch.js';
import { PRICE_SOURCE_URLS } from './sources.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const OPENROUTER = { data: [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } }] };
const VERCEL = { data: [{ id: 'typesafe-ai/jev', pricing: { input: '0.00000005', output: '0' } }] };
const MODELS_DEV = { anthropic: { models: { m: { id: 'm', cost: { input: 3, output: 15 } } } } };

/** Answers each fixed URL with its own responder; records the requests. */
function routedFetch(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError('unexpected url');
    return route(init);
  });
  return { fetch: fn as unknown as FetchLike, calls };
}

/** A body that streams `chunks` bytes of `size` each, then never ends unless `end` is set. */
function streamResponse(chunkSize: number, chunks: number): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(new Uint8Array(chunkSize).fill(32));
    },
  });
  return new Response(stream, { status: 200 });
}

describe('fetchPriceCatalog', () => {
  it('fetches the three fixed URLs without any key and returns every entry with per-source counts', async () => {
    const { fetch, calls } = routedFetch({
      [PRICE_SOURCE_URLS.openrouter]: () => json(OPENROUTER),
      [PRICE_SOURCE_URLS.vercel]: () => json(VERCEL),
      [PRICE_SOURCE_URLS['models.dev']]: () => json(MODELS_DEV),
    });
    const catalog = await fetchPriceCatalog({ fetch });

    expect(calls.map((c) => c.url).sort()).toEqual(Object.values(PRICE_SOURCE_URLS).sort());
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(call.init.method ?? 'GET').toBe('GET');
    }
    expect(catalog.entries.map((e) => `${e.source}:${e.provider}:${e.model}`).sort()).toEqual([
      'models.dev:anthropic:m',
      'openrouter:openrouter:a/b',
      'vercel:vercel-gateway:typesafe-ai/jev',
    ]);
    expect(catalog.sources.map(({ source, ok, count }) => ({ source, ok, count }))).toEqual([
      { source: 'openrouter', ok: true, count: 1 },
      { source: 'vercel', ok: true, count: 1 },
      { source: 'models.dev', ok: true, count: 1 },
    ]);
  });

  it('keeps the other sources when one fails (HTTP error, network error, bad JSON, no prices)', async () => {
    const cases: Array<[() => Response | Promise<Response>, string]> = [
      [() => new Response('<html>secret-looking body</html>', { status: 503 }), 'HTTP 503'],
      [() => Promise.reject(new TypeError('fetch failed')), 'network error'],
      [() => new Response('{not json', { status: 200 }), 'invalid JSON'],
      [() => json({ data: [] }), 'no prices found'],
    ];
    for (const [failing, error] of cases) {
      const { fetch } = routedFetch({
        [PRICE_SOURCE_URLS.openrouter]: failing,
        [PRICE_SOURCE_URLS.vercel]: () => json(VERCEL),
        [PRICE_SOURCE_URLS['models.dev']]: () => json(MODELS_DEV),
      });
      const catalog = await fetchPriceCatalog({ fetch });
      expect(catalog.sources[0]).toMatchObject({ source: 'openrouter', ok: false, count: 0, error });
      expect(catalog.sources[0]?.error).not.toContain('secret');
      expect(catalog.sources.slice(1).every((s) => s.ok && s.count === 1)).toBe(true);
      expect(catalog.entries.map((e) => e.source).sort()).toEqual(['models.dev', 'vercel']);
    }
  });

  it('stops reading a body over the size cap (by header or while streaming)', async () => {
    const bigHeader = (): Response =>
      new Response('{}', { status: 200, headers: { 'content-length': String(26 * 1024 * 1024) } });
    const { fetch } = routedFetch({
      [PRICE_SOURCE_URLS.openrouter]: bigHeader,
      [PRICE_SOURCE_URLS.vercel]: () => streamResponse(1024, 100),
      [PRICE_SOURCE_URLS['models.dev']]: () => json(MODELS_DEV),
    });
    const catalog = await fetchPriceCatalog({ fetch, maxBytes: 10 * 1024 });
    expect(catalog.sources[0]).toMatchObject({ ok: false, error: 'response too large' });
    expect(catalog.sources[1]).toMatchObject({ ok: false, error: 'response too large' });
    expect(catalog.sources[2]).toMatchObject({ ok: true, count: 1 });
  });

  it('times out a source that does not answer, while the others succeed', async () => {
    const hang = (init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    const { fetch } = routedFetch({
      [PRICE_SOURCE_URLS.openrouter]: () => json(OPENROUTER),
      [PRICE_SOURCE_URLS.vercel]: () => json(VERCEL),
      [PRICE_SOURCE_URLS['models.dev']]: hang,
    });
    const catalog = await fetchPriceCatalog({ fetch, timeoutMs: 30 });
    expect(catalog.sources[2]).toMatchObject({ source: 'models.dev', ok: false, error: 'timeout' });
    expect(catalog.sources.filter((s) => s.ok)).toHaveLength(2);
  });

  it('times out a body that stalls after the headers', async () => {
    const stalled = (): Response => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }));
    const { fetch } = routedFetch({
      [PRICE_SOURCE_URLS.openrouter]: stalled,
      [PRICE_SOURCE_URLS.vercel]: () => json(VERCEL),
      [PRICE_SOURCE_URLS['models.dev']]: () => json(MODELS_DEV),
    });
    const catalog = await fetchPriceCatalog({ fetch, timeoutMs: 30 });
    expect(catalog.sources[0]).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('reports aborted when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = routedFetch({
      [PRICE_SOURCE_URLS.openrouter]: (init) => (init.signal?.aborted ? Promise.reject(new DOMException('x', 'AbortError')) : json(OPENROUTER)),
      [PRICE_SOURCE_URLS.vercel]: () => json(VERCEL),
      [PRICE_SOURCE_URLS['models.dev']]: () => json(MODELS_DEV),
    });
    const catalog = await fetchPriceCatalog({ fetch, signal: controller.signal });
    expect(catalog.sources.every((s) => !s.ok && s.error === 'aborted')).toBe(true);
    expect(catalog.entries).toEqual([]);
  });
});

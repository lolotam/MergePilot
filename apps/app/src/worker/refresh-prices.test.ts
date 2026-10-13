import { PRICE_SOURCE_URLS, type FetchLike } from '@mergepilot/engine';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import { pricesNeedRefresh, runPriceRefresh, startPriceRefresh } from './refresh-prices.js';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const OPENROUTER = { data: [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } }] };
const VERCEL = { data: [{ id: 'typesafe-ai/jev', pricing: { input: '0.00000005', output: '0' } }] };
const MODELS_DEV = { anthropic: { models: { m: { id: 'm', cost: { input: 3, output: 15 } }, n: { id: 'n', cost: { input: 1, output: 1 } } } } };

function catalogFetch(overrides: Partial<Record<string, () => Response>> = {}): FetchLike {
  const routes: Record<string, () => Response> = {
    [PRICE_SOURCE_URLS.openrouter]: () => json(OPENROUTER),
    [PRICE_SOURCE_URLS.vercel]: () => json(VERCEL),
    [PRICE_SOURCE_URLS['models.dev']]: () => json(MODELS_DEV),
    ...overrides,
  };
  return (async (url: string) => {
    const route = routes[url];
    if (!route) throw new TypeError('unexpected url');
    return route();
  }) as FetchLike;
}

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('model price refresh job', () => {
  it('stores every source, records a refresh-prices run and logs per-source ok/count/ms', async () => {
    const store = new MemoryStore();
    const log = logger();
    const now = new Date('2026-10-13T02:30:00.000Z');
    const result = await runPriceRefresh(store, { fetch: catalogFetch(), logger: log, now: () => now });

    expect(result).toMatchObject({ count: 4, error: null });
    expect(await store.getModelPrice('anthropic', 'm')).toMatchObject({ inputPerMTok: 3, source: 'models.dev', fetchedAt: now });
    expect(await store.getModelPrice('vercel-gateway', 'typesafe-ai/jev')).toMatchObject({ inputPerMTok: 0.05 });
    expect(await store.getLatestMaintenanceRun('refresh-prices')).toMatchObject({ deletedCount: 4, error: null });

    const [fields, message] = log.info.mock.calls[0]!;
    expect(message).toContain('4 price(s)');
    expect(fields).toMatchObject({ event: 'prices.refresh', count: 4, failed: false });
    expect(fields.sources).toEqual([
      expect.objectContaining({ source: 'openrouter', ok: true, count: 1, ms: expect.any(Number) }),
      expect.objectContaining({ source: 'vercel', ok: true, count: 1 }),
      expect.objectContaining({ source: 'models.dev', ok: true, count: 2 }),
    ]);
  });

  it('keeps the stale rows of a source that failed and records the error, without the body', async () => {
    const store = new MemoryStore();
    await runPriceRefresh(store, { fetch: catalogFetch(), now: () => new Date('2026-10-12T02:30:00.000Z') });

    const log = logger();
    const failing = catalogFetch({ [PRICE_SOURCE_URLS['models.dev']]: () => new Response('<html>body-marker</html>', { status: 502 }) });
    const result = await runPriceRefresh(store, { fetch: failing, logger: log, now: () => new Date('2026-10-13T02:30:00.000Z') });

    expect(result).toMatchObject({ count: 2, error: 'models.dev: HTTP 502' });
    expect(await store.getModelPrice('anthropic', 'm')).toMatchObject({ fetchedAt: new Date('2026-10-12T02:30:00.000Z') });
    expect(await store.getModelPrice('openrouter', 'a/b')).toMatchObject({ fetchedAt: new Date('2026-10-13T02:30:00.000Z') });
    expect(await store.getLatestMaintenanceRun('refresh-prices')).toMatchObject({ deletedCount: 2, error: 'models.dev: HTTP 502' });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('body-marker');
  });

  it('records a store failure for that source and keeps going', async () => {
    const store = new MemoryStore();
    const replace = vi.spyOn(store, 'replaceModelPrices');
    replace.mockRejectedValueOnce(new Error('db down'));
    const result = await runPriceRefresh(store, { fetch: catalogFetch() });
    expect(result?.error).toBe('openrouter: store failed (Error)');
    expect(result?.count).toBe(3);
  });

  it('skips while another refresh holds the lease', async () => {
    const store = new MemoryStore();
    const lease = await startPriceRefresh(store, { fetch: catalogFetch() });
    expect(lease).not.toBeNull();
    const log = logger();
    expect(await runPriceRefresh(store, { fetch: catalogFetch(), logger: log })).toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'prices.refresh_skipped' }), expect.any(String));
    await lease?.execute();
    expect((await store.getLatestMaintenanceRun('refresh-prices'))?.finishedAt).toBeInstanceOf(Date);
  });

  it('needs a refresh when the table is empty or the newest price is older than 24 h', async () => {
    const store = new MemoryStore();
    const now = new Date('2026-10-13T12:00:00.000Z');
    expect(await pricesNeedRefresh(store, now)).toBe(true);
    await store.replaceModelPrices('openrouter', [{ provider: 'openrouter', model: 'x', inputPerMTok: 1, outputPerMTok: 1, source: 'openrouter' }], new Date('2026-10-12T11:00:00.000Z'));
    expect(await pricesNeedRefresh(store, now)).toBe(true);
    await store.replaceModelPrices('vercel', [{ provider: 'vercel-gateway', model: 'y', inputPerMTok: 1, outputPerMTok: 1, source: 'vercel' }], new Date('2026-10-12T13:00:00.000Z'));
    expect(await pricesNeedRefresh(store, now)).toBe(false);
  });
});

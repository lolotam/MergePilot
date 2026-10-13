import { fetchPriceCatalog, type FetchLike, type PriceSourceResult } from '@mergepilot/engine';
import type { AppStore, MaintenanceRun } from '../core/types.js';
import type { RetentionLogger } from './retention.js';

/** An unfinished price refresh older than this is treated as crashed and its lease is taken over. */
export const PRICE_REFRESH_LEASE_STALE_MS = 60 * 60 * 1000;
/** At worker startup, prices older than this (or none at all) trigger a refresh. */
export const PRICES_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const MAX_ERROR_LENGTH = 500;

export interface PriceRefreshOptions {
  fetch?: FetchLike | undefined;
  now?: () => Date;
  logger?: RetentionLogger | undefined;
  /** Test seam: per-source timeout. */
  timeoutMs?: number | undefined;
}

export interface PriceRefreshResult {
  runId: string;
  /** Prices stored across the sources that fetched OK. */
  count: number;
  sources: PriceSourceResult[];
  error: string | null;
}

export interface PriceRefreshLease {
  run: MaintenanceRun;
  execute: () => Promise<PriceRefreshResult>;
}

/** Takes the `refresh-prices` lease; null when another refresh holds it. */
export async function startPriceRefresh(store: AppStore, options: PriceRefreshOptions = {}): Promise<PriceRefreshLease | null> {
  const now = options.now ?? (() => new Date());
  const run = await store.startMaintenanceRun('refresh-prices', new Date(now().getTime() - PRICE_REFRESH_LEASE_STALE_MS));
  if (!run) return null;
  return { run, execute: () => executePriceRefresh(store, run, options) };
}

/**
 * Fetches every price list and replaces the stored rows of each source that fetched OK. A source
 * that failed keeps its stored (stale) rows. Logs `prices.refresh` with per-source ok/count/ms,
 * never a response body.
 */
async function executePriceRefresh(store: AppStore, run: MaintenanceRun, options: PriceRefreshOptions): Promise<PriceRefreshResult> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const errors: string[] = [];
  let count = 0;
  let sources: PriceSourceResult[] = [];
  try {
    const catalog = await fetchPriceCatalog({ fetch: options.fetch, timeoutMs: options.timeoutMs });
    sources = catalog.sources;
    const fetchedAt = now();
    for (const result of catalog.sources) {
      if (!result.ok) {
        errors.push(`${result.source}: ${result.error ?? 'failed'}`);
        continue;
      }
      try {
        const entries = catalog.entries.filter((e) => e.source === result.source);
        count += await store.replaceModelPrices(result.source, entries, fetchedAt);
      } catch (err) {
        errors.push(`${result.source}: store failed (${err instanceof Error ? err.name : 'error'})`);
      }
    }
  } catch (err) {
    errors.push(`refresh failed (${err instanceof Error ? err.name : 'error'})`);
  }
  const error = errors.length > 0 ? errors.join('; ').slice(0, MAX_ERROR_LENGTH) : null;
  await store.finishMaintenanceRun(run.id, { deletedCount: count, error });
  options.logger?.info(
    {
      event: 'prices.refresh',
      runId: run.id,
      count,
      ms: Date.now() - started,
      sources: sources.map((s) => ({ source: s.source, ok: s.ok, count: s.count, ms: s.ms, ...(s.error ? { error: s.error } : {}) })),
      failed: error !== null,
    },
    `Model prices refreshed: ${count} price(s) stored`,
  );
  return { runId: run.id, count, sources, error };
}

/** Takes the lease and refreshes; null when another refresh is in progress. */
export async function runPriceRefresh(store: AppStore, options: PriceRefreshOptions = {}): Promise<PriceRefreshResult | null> {
  const lease = await startPriceRefresh(store, options);
  if (!lease) {
    options.logger?.info({ event: 'prices.refresh_skipped', reason: 'lease_held' }, 'Model price refresh skipped: already running');
    return null;
  }
  return lease.execute();
}

/** True when no price is stored or the newest one is older than 24 h. */
export async function pricesNeedRefresh(store: Pick<AppStore, 'pricesFetchedAt'>, now: Date = new Date()): Promise<boolean> {
  const fetched = await store.pricesFetchedAt();
  if (fetched.length === 0) return true;
  const newest = Math.max(...fetched.map((f) => f.fetchedAt.getTime()));
  return now.getTime() - newest > PRICES_STALE_AFTER_MS;
}

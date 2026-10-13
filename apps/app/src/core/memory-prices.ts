import type { PriceEntry, PriceSource } from '@mergepilot/engine';
import { pickPrice, type ModelKey, type StoredModelPrice } from './price-types.js';

/** In-memory twin of pg-prices.ts, used by MemoryStore. Keyed by provider, NUL, model. */
export class MemoryPriceTable {
  private readonly rows = new Map<string, StoredModelPrice>();

  replace(source: PriceSource, entries: readonly PriceEntry[], fetchedAt: Date): number {
    const next = new Map<string, StoredModelPrice>();
    for (const e of entries) {
      const key = `${e.provider}\u0000${e.model}`;
      if (!next.has(key)) next.set(key, { ...e, source, fetchedAt: new Date(fetchedAt) });
    }
    for (const [key, row] of this.rows) if (row.source === source && !next.has(key)) this.rows.delete(key);
    for (const [key, row] of next) this.rows.set(key, row);
    return next.size;
  }

  list(keys: readonly ModelKey[]): StoredModelPrice[] {
    const wanted = new Set(keys.map((k) => `${k.provider.toLowerCase()}\u0000${k.model.toLowerCase()}`));
    return [...this.rows.values()]
      .filter((r) => wanted.has(`${r.provider.toLowerCase()}\u0000${r.model.toLowerCase()}`))
      .sort((a, b) => `${a.provider}\u0000${a.model}`.localeCompare(`${b.provider}\u0000${b.model}`))
      .map((r) => ({ ...r, fetchedAt: new Date(r.fetchedAt) }));
  }

  get(provider: string, model: string): StoredModelPrice | null {
    return pickPrice(this.list([{ provider, model }]), provider, model) ?? null;
  }

  fetchedAt(): Array<{ source: PriceSource; fetchedAt: Date }> {
    const newest = new Map<PriceSource, Date>();
    for (const r of this.rows.values()) {
      const seen = newest.get(r.source);
      if (!seen || r.fetchedAt > seen) newest.set(r.source, r.fetchedAt);
    }
    return [...newest].sort(([a], [b]) => a.localeCompare(b)).map(([source, at]) => ({ source, fetchedAt: new Date(at) }));
  }
}

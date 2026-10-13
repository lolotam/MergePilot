import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { PriceEntry, PriceSource } from '@mergepilot/engine';
import { pickPrice, type ModelKey, type StoredModelPrice } from '../core/price-types.js';
import type { AppDb } from './pg-store.js';
import { modelPrices } from './schema.js';

/** Rows per INSERT statement: models.dev lists a few thousand models. */
const UPSERT_CHUNK = 500;

const num = (value: string | null): number | undefined => (value === null ? undefined : Number(value));

function mapRow(row: typeof modelPrices.$inferSelect): StoredModelPrice {
  const cacheRead = num(row.cacheReadPerMTok);
  const cacheWrite = num(row.cacheWritePerMTok);
  return {
    provider: row.provider,
    model: row.model,
    inputPerMTok: Number(row.inputPerMTok),
    outputPerMTok: Number(row.outputPerMTok),
    ...(cacheRead !== undefined ? { cacheReadPerMTok: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWritePerMTok: cacheWrite } : {}),
    source: row.source as PriceSource,
    fetchedAt: new Date(row.fetchedAt),
  };
}

const str = (value: number | undefined): string | null => (value === undefined ? null : String(value));

/** Upserts this source's entries and deletes its rows not in the new set, in one transaction. */
export async function replacePgModelPrices(
  db: AppDb,
  source: PriceSource,
  entries: readonly PriceEntry[],
  fetchedAt: Date,
): Promise<number> {
  // One row per key: the first entry wins, like the parsers.
  const byKey = new Map<string, PriceEntry>();
  for (const e of entries) {
    const key = `${e.provider}\u0000${e.model}`;
    if (!byKey.has(key)) byKey.set(key, e);
  }
  const rows = [...byKey.values()].map((e) => ({
    provider: e.provider,
    model: e.model,
    inputPerMTok: String(e.inputPerMTok),
    outputPerMTok: String(e.outputPerMTok),
    cacheReadPerMTok: str(e.cacheReadPerMTok),
    cacheWritePerMTok: str(e.cacheWritePerMTok),
    source,
    fetchedAt,
  }));
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      await tx
        .insert(modelPrices)
        .values(rows.slice(i, i + UPSERT_CHUNK))
        .onConflictDoUpdate({
          target: [modelPrices.provider, modelPrices.model],
          set: {
            inputPerMTok: sql`excluded.input_per_mtok`,
            outputPerMTok: sql`excluded.output_per_mtok`,
            cacheReadPerMTok: sql`excluded.cache_read_per_mtok`,
            cacheWritePerMTok: sql`excluded.cache_write_per_mtok`,
            source: sql`excluded.source`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }
    // Rows of this source that the new list no longer has (the upsert refreshed fetched_at of the rest).
    const stale = rows.length > 0 ? sql`${modelPrices.fetchedAt} <> ${fetchedAt}` : sql`true`;
    await tx.delete(modelPrices).where(and(eq(modelPrices.source, source), stale));
  });
  return rows.length;
}

function keyConditions(keys: readonly ModelKey[]): SQL | undefined {
  return or(
    ...keys.map(
      (k) => sql`(lower(${modelPrices.provider}) = lower(${k.provider}) AND lower(${modelPrices.model}) = lower(${k.model}))`,
    ),
  );
}

export async function listPgModelPrices(db: AppDb, keys: readonly ModelKey[]): Promise<StoredModelPrice[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select()
    .from(modelPrices)
    .where(keyConditions(keys))
    .orderBy(asc(modelPrices.provider), asc(modelPrices.model));
  return rows.map(mapRow);
}

export async function getPgModelPrice(db: AppDb, provider: string, model: string): Promise<StoredModelPrice | null> {
  return pickPrice(await listPgModelPrices(db, [{ provider, model }]), provider, model) ?? null;
}

export async function pgPricesFetchedAt(db: AppDb): Promise<Array<{ source: PriceSource; fetchedAt: Date }>> {
  const rows = await db
    .select({ source: modelPrices.source, fetchedAt: sql<Date | string>`max(${modelPrices.fetchedAt})` })
    .from(modelPrices)
    .groupBy(modelPrices.source)
    .orderBy(asc(modelPrices.source));
  return rows.map((r) => ({ source: r.source as PriceSource, fetchedAt: new Date(r.fetchedAt) }));
}

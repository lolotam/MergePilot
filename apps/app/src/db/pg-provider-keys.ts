import { and, asc, eq } from 'drizzle-orm';
import { clampKeyCursor } from '../core/key-cursor.js';
import type { KeyProvider, KeyQuotaStatus, StoredProviderKey } from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { providerApiKeys, providerKeyCursors } from './schema.js';
import type { AppTx } from './workspace-lock.js';

type PgReader = AppDb | AppTx;

function quotaStatus(value: string | null): KeyQuotaStatus | null {
  if (value === 'valid' || value === 'invalid' || value === 'quota-exhausted') return value;
  return null;
}

function mapKey(row: typeof providerApiKeys.$inferSelect): StoredProviderKey {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider as KeyProvider,
    position: row.position,
    ciphertext: row.ciphertext,
    keyVersion: row.keyVersion,
    last4: row.last4,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt),
    lastTestStatus: quotaStatus(row.lastTestStatus),
    lastTestedAt: row.lastTestedAt ? new Date(row.lastTestedAt) : null,
  };
}

export { clampKeyCursor };

export async function listPgProviderKeys(
  db: PgReader,
  workspaceId: string,
  provider?: string,
): Promise<StoredProviderKey[]> {
  const where = provider
    ? and(eq(providerApiKeys.workspaceId, workspaceId), eq(providerApiKeys.provider, provider))
    : eq(providerApiKeys.workspaceId, workspaceId);
  const rows = await db.select().from(providerApiKeys).where(where).orderBy(asc(providerApiKeys.position));
  return rows.map(mapKey);
}

/** Deletes the provider's slots, then inserts `keys`. The caller holds the credential lock. */
export async function replacePgProviderKeys(
  tx: AppTx,
  workspaceId: string,
  provider: string,
  keys: readonly StoredProviderKey[],
): Promise<void> {
  await tx
    .delete(providerApiKeys)
    .where(and(eq(providerApiKeys.workspaceId, workspaceId), eq(providerApiKeys.provider, provider)));
  if (keys.length === 0) return;
  await tx.insert(providerApiKeys).values(
    keys.map((key) => ({
      id: key.id,
      workspaceId,
      provider,
      position: key.position,
      ciphertext: key.ciphertext,
      keyVersion: key.keyVersion,
      last4: key.last4,
      createdBy: key.createdBy,
      createdAt: key.createdAt,
      lastTestStatus: key.lastTestStatus,
      lastTestedAt: key.lastTestedAt,
    })),
  );
}

export async function readPgKeyCursor(db: PgReader, workspaceId: string, provider: string): Promise<number | null> {
  const rows = await db
    .select({ position: providerKeyCursors.position })
    .from(providerKeyCursors)
    .where(and(eq(providerKeyCursors.workspaceId, workspaceId), eq(providerKeyCursors.provider, provider)));
  return rows[0]?.position ?? null;
}

/** `null` removes the cursor. Otherwise upserts the position in the caller's transaction. */
export async function writePgKeyCursor(
  tx: AppTx,
  workspaceId: string,
  provider: string,
  position: number | null,
): Promise<void> {
  if (position === null) {
    await tx
      .delete(providerKeyCursors)
      .where(and(eq(providerKeyCursors.workspaceId, workspaceId), eq(providerKeyCursors.provider, provider)));
    return;
  }
  const updatedAt = new Date();
  await tx
    .insert(providerKeyCursors)
    .values({ workspaceId, provider, position, updatedAt })
    .onConflictDoUpdate({
      target: [providerKeyCursors.workspaceId, providerKeyCursors.provider],
      set: { position, updatedAt },
    });
}

export async function deletePgProviderKeyRows(tx: AppTx, workspaceId: string, provider: string): Promise<void> {
  await tx
    .delete(providerApiKeys)
    .where(and(eq(providerApiKeys.workspaceId, workspaceId), eq(providerApiKeys.provider, provider)));
  await writePgKeyCursor(tx, workspaceId, provider, null);
}

export async function recordPgProviderKeyTest(
  tx: AppTx,
  workspaceId: string,
  provider: string,
  keyId: string,
  status: KeyQuotaStatus,
  testedAt: Date,
): Promise<boolean> {
  const updated = await tx
    .update(providerApiKeys)
    .set({ lastTestStatus: status, lastTestedAt: testedAt })
    .where(
      and(
        eq(providerApiKeys.workspaceId, workspaceId),
        eq(providerApiKeys.provider, provider),
        eq(providerApiKeys.id, keyId),
      ),
    )
    .returning();
  return updated.length > 0;
}

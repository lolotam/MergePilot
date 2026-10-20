import { and, eq } from 'drizzle-orm';
import { clampKeyCursor } from '../core/key-cursor.js';
import type { KeyProvider, KeyQuotaStatus, ProviderAuthMethod, ProviderKeyChange, StoredProviderKey } from '../core/types.js';
import { deletePgAuthPreference, writePgAuthPreference } from './pg-auth-preferences.js';
import { writePgCredential } from './pg-backup.js';
import {
  listPgProviderKeys,
  readPgKeyCursor,
  recordPgProviderKeyTest,
  replacePgProviderKeys,
  writePgKeyCursor,
} from './pg-provider-keys.js';
import type { AppDb } from './pg-store.js';
import { providerCredentials } from './schema.js';
import { lockCredential, withLiveWorkspace, type AppTx } from './workspace-lock.js';
import type { StoredCredential } from '../core/types.js';

/** A `provider_credentials` row as a StoredCredential. */
export function mapCredentialRow(row: typeof providerCredentials.$inferSelect): StoredCredential {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider as KeyProvider,
    ciphertext: row.ciphertext,
    keyVersion: row.keyVersion,
    last4: row.last4,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt),
    baseUrl: row.baseUrl ?? null,
    signInRequiredAt: row.signInRequiredAt ?? null,
  };
}

export async function readParentCredential(tx: AppTx, workspaceId: string, provider: KeyProvider): Promise<StoredCredential | null> {
  const rows = await tx
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.workspaceId, workspaceId), eq(providerCredentials.provider, provider)));
  const row = rows[0];
  return row ? mapCredentialRow(row) : null;
}

/** Ordered slots for one provider. The secret stays in `ciphertext`. */
export function listStoredProviderKeys(db: AppDb, workspaceId: string, provider: KeyProvider): Promise<StoredProviderKey[]> {
  return listPgProviderKeys(db, workspaceId, provider);
}

export function listWorkspaceStoredProviderKeys(db: AppDb, workspaceId: string): Promise<StoredProviderKey[]> {
  return listPgProviderKeys(db, workspaceId);
}

/**
 * Replaces the ordered slots and, when the change says so, the parent credential.
 * The credential advisory lock is held for the whole change, including the cursor.
 */
async function applyPgAuthPreference(
  tx: AppTx,
  workspaceId: string,
  provider: KeyProvider,
  authPreference: ProviderAuthMethod | null | undefined,
): Promise<void> {
  if (authPreference === undefined) return;
  if (authPreference === null) await deletePgAuthPreference(tx, workspaceId, provider);
  else await writePgAuthPreference(tx, workspaceId, provider, authPreference);
}

/** Writes one provider-key change inside an open transaction (caller holds the credential lock). */
export async function writeProviderKeyChangeTx(
  tx: AppTx,
  workspaceId: string,
  provider: KeyProvider,
  next: ProviderKeyChange,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (next.parent === null) {
    await tx.delete(providerCredentials)
      .where(and(eq(providerCredentials.workspaceId, workspaceId), eq(providerCredentials.provider, provider)));
  } else if (next.parent) {
    await writePgCredential(tx, next.parent);
  }
  const keys = [...next.keys].sort((a, b) => a.position - b.position);
  await replacePgProviderKeys(tx, workspaceId, provider, keys);
  if (keys.length === 0) await writePgKeyCursor(tx, workspaceId, provider, null);
  else if (next.cursor !== undefined) await writePgKeyCursor(tx, workspaceId, provider, clampKeyCursor(next.cursor, keys.length));
  else {
    const stored = await readPgKeyCursor(tx, workspaceId, provider);
    if (stored !== null) await writePgKeyCursor(tx, workspaceId, provider, clampKeyCursor(stored, keys.length));
  }
  await applyPgAuthPreference(tx, workspaceId, provider, next.authPreference);
  signal?.throwIfAborted();
}

export async function modifyStoredProviderKeys(
  db: AppDb,
  workspaceId: string,
  provider: KeyProvider,
  change: (current: StoredProviderKey[], parent: StoredCredential | null) => Promise<ProviderKeyChange>,
  signal?: AbortSignal,
): Promise<StoredProviderKey[]> {
  return withLiveWorkspace(db, workspaceId, async (tx) => {
    await lockCredential(tx, workspaceId, provider);
    const parent = await readParentCredential(tx, workspaceId, provider);
    const next = await change(await listPgProviderKeys(tx, workspaceId, provider), parent);
    await writeProviderKeyChangeTx(tx, workspaceId, provider, next, signal);
    const written = await listPgProviderKeys(tx, workspaceId, provider);
    // Last check before COMMIT: a cancellation during the read above still rolls everything back.
    signal?.throwIfAborted();
    return written;
  });
}

/** Missing, empty, or out-of-range cursors read as 0. */
export async function readStoredKeyCursor(db: AppDb, workspaceId: string, provider: KeyProvider): Promise<number> {
  const keys = await listPgProviderKeys(db, workspaceId, provider);
  if (keys.length === 0) return 0;
  const stored = await readPgKeyCursor(db, workspaceId, provider);
  if (stored === null || !Number.isInteger(stored) || stored < 0 || stored >= keys.length) return 0;
  return stored;
}

/** No slots means there is nothing to remember, so the cursor row is removed. */
export async function writeStoredKeyCursor(db: AppDb, workspaceId: string, provider: KeyProvider, keyId: string): Promise<void> {
  await withLiveWorkspace(db, workspaceId, async (tx) => {
    await lockCredential(tx, workspaceId, provider);
    const keys = await listPgProviderKeys(tx, workspaceId, provider);
    if (keys.length === 0) {
      await writePgKeyCursor(tx, workspaceId, provider, null);
      return;
    }
    const index = keys.findIndex((row) => row.id === keyId);
    if (index < 0) return;
    await writePgKeyCursor(tx, workspaceId, provider, index);
  });
}

/** Records a stored-key test under the credential lock. False when the id is absent. */
export async function recordStoredProviderKeyTest(
  db: AppDb,
  workspaceId: string,
  provider: KeyProvider,
  recorded: { keyId: string; status: KeyQuotaStatus; testedAt: Date },
): Promise<boolean> {
  return withLiveWorkspace(db, workspaceId, async (tx) => {
    await lockCredential(tx, workspaceId, provider);
    return recordPgProviderKeyTest(tx, workspaceId, provider, recorded.keyId, recorded.status, recorded.testedAt);
  });
}

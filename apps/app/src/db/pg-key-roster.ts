import { and, eq } from 'drizzle-orm';
import { clampKeyCursor } from '../core/key-cursor.js';
import type { KeyProvider, KeyQuotaStatus, ProviderKeyChange, StoredProviderKey } from '../core/types.js';
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
import { lockCredential, withLiveWorkspace } from './workspace-lock.js';

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
export async function modifyStoredProviderKeys(
  db: AppDb,
  workspaceId: string,
  provider: KeyProvider,
  change: (current: StoredProviderKey[]) => Promise<ProviderKeyChange>,
): Promise<StoredProviderKey[]> {
  return withLiveWorkspace(db, workspaceId, async (tx) => {
    await lockCredential(tx, workspaceId, provider);
    const next = await change(await listPgProviderKeys(tx, workspaceId, provider));
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
    return listPgProviderKeys(tx, workspaceId, provider);
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
export async function writeStoredKeyCursor(db: AppDb, workspaceId: string, provider: KeyProvider, position: number): Promise<void> {
  await withLiveWorkspace(db, workspaceId, async (tx) => {
    await lockCredential(tx, workspaceId, provider);
    const keys = await listPgProviderKeys(tx, workspaceId, provider);
    if (keys.length === 0) {
      await writePgKeyCursor(tx, workspaceId, provider, null);
      return;
    }
    await writePgKeyCursor(tx, workspaceId, provider, clampKeyCursor(position, keys.length));
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

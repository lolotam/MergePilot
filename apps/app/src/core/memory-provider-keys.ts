import { clampKeyCursor } from './key-cursor.js';
import type { KeyProvider, KeyQuotaStatus, ProviderKeyChange, StoredCredential, StoredProviderKey } from './types.js';

/** In-memory twin of the provider-key tables. Keyed like credentials (`workspaceId:provider`). */
export interface MemoryKeyTables {
  credentials: Map<string, StoredCredential>;
  providerKeys: Map<string, StoredProviderKey[]>;
  keyCursors: Map<string, number>;
}

type Locked = <T>(work: () => Promise<T>) => Promise<T>;

/** The in-memory tables plus the credential lock the store already holds for this provider. */
export interface MemoryKeyLock {
  tables: MemoryKeyTables;
  runLocked: Locked;
  assertLive: (workspaceId: string) => void;
}

const slotKey = (workspaceId: string, provider: string): string => `${workspaceId}:${provider}`;

const copies = (rows: readonly StoredProviderKey[]): StoredProviderKey[] => rows.map((row) => ({ ...row }));

export function listMemoryProviderKeys(
  tables: MemoryKeyTables,
  workspaceId: string,
  provider: KeyProvider,
): StoredProviderKey[] {
  return copies(tables.providerKeys.get(slotKey(workspaceId, provider)) ?? []).sort((a, b) => a.position - b.position);
}

export function listMemoryWorkspaceProviderKeys(tables: MemoryKeyTables, workspaceId: string): StoredProviderKey[] {
  return [...tables.providerKeys.values()]
    .flat()
    .filter((key) => key.workspaceId === workspaceId)
    .map((key) => ({ ...key }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.position - b.position);
}

/** Applies a slot change under the caller's credential lock. An empty list drops the cursor. */
export async function modifyMemoryProviderKeys(
  lock: MemoryKeyLock,
  workspaceId: string,
  provider: KeyProvider,
  change: (current: StoredProviderKey[]) => Promise<ProviderKeyChange>,
): Promise<StoredProviderKey[]> {
  const { tables } = lock;
  return lock.runLocked(async () => {
    lock.assertLive(workspaceId);
    const key = slotKey(workspaceId, provider);
    const next = await change(copies(tables.providerKeys.get(key) ?? []));
    lock.assertLive(workspaceId);
    if (next.parent === null) tables.credentials.delete(key);
    else if (next.parent) tables.credentials.set(key, { ...next.parent });
    const keys = copies(next.keys).sort((a, b) => a.position - b.position);
    if (keys.length === 0) {
      tables.providerKeys.delete(key);
      tables.keyCursors.delete(key);
      return [];
    }
    tables.providerKeys.set(key, keys);
    if (next.cursor !== undefined) tables.keyCursors.set(key, clampKeyCursor(next.cursor, keys.length));
    else if (tables.keyCursors.has(key)) tables.keyCursors.set(key, clampKeyCursor(tables.keyCursors.get(key) ?? 0, keys.length));
    return copies(keys);
  });
}

/** Missing, empty, or out-of-range cursors read as 0. The row is left untouched. */
export function readMemoryKeyCursor(tables: MemoryKeyTables, workspaceId: string, provider: KeyProvider): number {
  const length = tables.providerKeys.get(slotKey(workspaceId, provider))?.length ?? 0;
  if (length === 0) return 0;
  const stored = tables.keyCursors.get(slotKey(workspaceId, provider));
  if (stored === undefined || !Number.isInteger(stored) || stored < 0 || stored >= length) return 0;
  return stored;
}

/** No slots means there is nothing to remember, so the cursor row is removed. */
export async function writeMemoryKeyCursor(
  lock: MemoryKeyLock,
  workspaceId: string,
  provider: KeyProvider,
  keyId: string,
): Promise<void> {
  await lock.runLocked(async () => {
    lock.assertLive(workspaceId);
    const key = slotKey(workspaceId, provider);
    const rows = lock.tables.providerKeys.get(key) ?? [];
    if (rows.length === 0) {
      lock.tables.keyCursors.delete(key);
      return;
    }
    const index = rows.findIndex((row) => row.id === keyId);
    if (index < 0) return;
    lock.tables.keyCursors.set(key, index);
  });
}

/** Records a stored-key test. Returns false when the id is not in this provider's list. */
export async function recordMemoryProviderKeyTest(
  lock: MemoryKeyLock,
  workspaceId: string,
  provider: KeyProvider,
  recorded: { keyId: string; status: KeyQuotaStatus; testedAt: Date },
): Promise<boolean> {
  return lock.runLocked(async () => {
    lock.assertLive(workspaceId);
    const rows = lock.tables.providerKeys.get(slotKey(workspaceId, provider));
    const index = rows?.findIndex((row) => row.id === recorded.keyId) ?? -1;
    const current = rows?.[index];
    if (!rows || !current) return false;
    rows[index] = { ...current, lastTestStatus: recorded.status, lastTestedAt: recorded.testedAt };
    return true;
  });
}

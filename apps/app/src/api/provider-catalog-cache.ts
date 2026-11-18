import { createHash } from 'node:crypto';
import type { CatalogModel } from '@mergepilot/engine';
import type { AppStore, KeyProvider } from '../core/types.js';
import { isDualMethodProvider, isKeyListProvider } from '../credentials/multi-key.js';

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;
type CatalogMode = 'ordinary' | 'sync';
type CatalogRead = { count: number; started: number; lastPublished: number; lastSyncPublished: number };
type CachedCatalog = { revision: string; mode: CatalogMode; models: CatalogModel[]; expiresAt: number };
const cache = new Map<string, CachedCatalog>();
const active = new Map<string, CatalogRead>();

/** Read shared credential identities without treating OAuth token rotation as a new account. */
export async function catalogCredentialRevision(store: AppStore, workspaceId: string, provider: KeyProvider): Promise<string> {
  const parent = await store.getCredential(workspaceId, provider);
  const slotInputs = isKeyListProvider(provider) ? await Promise.all([
    store.listProviderKeys(workspaceId, provider), store.getKeyCursor(workspaceId, provider),
    isDualMethodProvider(provider) ? store.getProviderAuthPreference(workspaceId, provider) : null,
  ]) : null;
  const slots = slotInputs?.[0].map(({ id, position, createdAt }) => [id, position, createdAt]);
  return createHash('sha256').update(JSON.stringify([
    parent && [parent.id, parent.createdAt, parent.baseUrl, parent.signInRequiredAt],
    slots, slotInputs?.[1], slotInputs?.[2],
  ])).digest('hex');
}

export function cachedCatalog(key: string, revision: string): CachedCatalog | undefined {
  const saved = cache.get(key);
  return saved?.revision === revision && saved.expiresAt > Date.now() ? saved : undefined;
}

export function invalidateModelsCache(workspaceId: string, provider: string): void {
  const key = `${workspaceId}:${provider}`;
  cache.delete(key);
  active.delete(key);
}

export function resetCatalogCache(): void {
  cache.clear();
  active.clear();
}

function saveCatalog(key: string, entry: Omit<CachedCatalog, 'expiresAt'>): void {
  const now = Date.now();
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    for (const [id, item] of cache) if (item.expiresAt <= now) cache.delete(id);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  cache.set(key, { ...entry, expiresAt: now + TTL_MS });
}

type Publication = { models: CatalogModel[] } | 'catalog_credentials_changed' | 'catalog_superseded';

export function beginCatalogRead(key: string, revision: string, mode: CatalogMode) {
  const group = active.get(key) ?? { count: 0, started: 0, lastPublished: 0, lastSyncPublished: 0 };
  active.set(key, group);
  group.count++;
  const sequence = ++group.started;
  return {
    publish(models: CatalogModel[]): Publication {
      if (active.get(key) !== group) return 'catalog_credentials_changed';
      const saved = cachedCatalog(key, revision);
      // A general picker refresh must never replace a verified account catalog.
      if (saved?.mode === 'sync' && mode === 'ordinary') return { models: saved.models };
      const latest = mode === 'sync' ? group.lastSyncPublished : group.lastPublished;
      if (sequence < latest) return 'catalog_superseded';
      saveCatalog(key, { revision, mode, models });
      group.lastPublished = Math.max(sequence, group.lastPublished);
      if (mode === 'sync') group.lastSyncPublished = sequence;
      return { models };
    },
    finish() {
      group.count--;
      if (group.count === 0 && active.get(key) === group) active.delete(key);
    },
  };
}

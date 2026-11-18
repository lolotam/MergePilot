import { createHash } from 'node:crypto';
import type { CatalogModel } from '@mergepilot/engine';
import type { AppStore, KeyProvider } from '../core/types.js';

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;
type CatalogMode = 'ordinary' | 'sync';
type CatalogRead = { count: number; started: number; lastPublished: number; lastSyncPublished: number; syncPublications: number };
type CachedCatalog = { revision: string; mode: CatalogMode; models: CatalogModel[]; expiresAt: number };
const cache = new Map<string, CachedCatalog>();
const active = new Map<string, CatalogRead>();

/** Read shared credential identities without treating OAuth token rotation as a new account. */
export async function catalogCredentialRevision(store: AppStore, workspaceId: string, provider: KeyProvider) {
  const state = await store.readCatalogCredentialState(workspaceId, provider);
  return { revision: createHash('sha256').update(JSON.stringify(state)).digest('hex'), slotId: state?.slots[state.cursor]?.id };
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
  const group = active.get(key) ?? { count: 0, started: 0, lastPublished: 0, lastSyncPublished: 0, syncPublications: 0 };
  active.set(key, group);
  group.count++;
  const sequence = ++group.started;
  const initialSyncPublications = group.syncPublications;
  const startedWithSync = mode === 'ordinary' && cachedCatalog(key, revision)?.mode === 'sync';
  return {
    publish(models: CatalogModel[]): Publication {
      if (active.get(key) !== group) return 'catalog_credentials_changed';
      const saved = cachedCatalog(key, revision);
      // A general picker refresh must never replace a verified account catalog.
      if (mode === 'ordinary') {
        if (saved?.mode === 'sync') return { models: saved.models };
        if (startedWithSync || group.syncPublications !== initialSyncPublications) return 'catalog_superseded';
      }
      const latest = mode === 'sync' ? group.lastSyncPublished : group.lastPublished;
      if (sequence < latest) return 'catalog_superseded';
      saveCatalog(key, { revision, mode, models });
      group.lastPublished = Math.max(sequence, group.lastPublished);
      if (mode === 'sync') {
        group.lastSyncPublished = sequence;
        group.syncPublications++;
      }
      return { models };
    },
    finish() {
      group.count--;
      if (group.count === 0 && active.get(key) === group) active.delete(key);
    },
  };
}

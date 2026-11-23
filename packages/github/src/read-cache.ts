import type { GitHubClient } from './client.js';

/**
 * Content at a commit never changes, so reads are shared per client: the bots of one reviewer
 * panel use the same client and read the same file at the same commit once (owner rules at the
 * base, repository context at the head). The cache lives as long as the client: the Action makes
 * one per run and the App one per job (`guardWritesForWorkspace` wraps each job's client in a new
 * object), so it never outlives a review.
 */
/** Maximum decoded text retained across settled `maxBytes` reads on one client. */
export const MAX_LARGE_READ_CACHE_CHARS = 16 * 1024 * 1024;

interface LargeCacheState {
  totalChars: number;
  entries: Map<string, { promise: Promise<string | null>; chars: number }>;
}

const readCache = new WeakMap<GitHubClient, Map<string, Promise<string | null>>>();
const largeCacheStates = new WeakMap<GitHubClient, LargeCacheState>();
const listCache = new WeakMap<GitHubClient, Map<string, Promise<string[] | null>>>();

/**
 * The cached request of `key` for this client, started with `start` the first time. A failed
 * request is dropped from the cache, so a transient error (5xx, secondary rate limit) does not stay
 * a failure for the rest of the job.
 */
function shared<T>(caches: WeakMap<GitHubClient, Map<string, Promise<T>>>, client: GitHubClient, key: string, start: () => Promise<T>): Promise<T> {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  let request = cache.get(key);
  if (!request) {
    const pending = start();
    pending.catch(() => {
      if (cache?.get(key) === pending) cache.delete(key);
    });
    request = pending;
    cache.set(key, request);
  }
  return request;
}

/**
 * Shares in-flight large-file reads and keeps settled results under a per-client character cap so
 * multi-file patch rebuilds do not retain unbounded megabytes until the review ends.
 */
function sharedBounded(
  client: GitHubClient,
  key: string,
  start: () => Promise<string | null>,
  maxChars: number,
): Promise<string | null> {
  let cache = readCache.get(client);
  if (!cache) {
    cache = new Map();
    readCache.set(client, cache);
  }
  let state = largeCacheStates.get(client);
  if (!state) {
    state = { totalChars: 0, entries: new Map() };
    largeCacheStates.set(client, state);
  }
  const existing = cache.get(key);
  if (existing) {
    const tracked = state.entries.get(key);
    if (tracked && tracked.promise === existing) {
      state.entries.delete(key);
      state.entries.set(key, tracked);
    }
    return existing;
  }
  const pending = start();
  cache.set(key, pending);
  pending.then(
    (text) => {
      if (cache.get(key) !== pending || text === null) return;
      const chars = text.length;
      if (chars > maxChars) {
        cache.delete(key);
        return;
      }
      state.entries.set(key, { promise: pending, chars });
      state.totalChars += chars;
      while (state.totalChars > maxChars) {
        const oldest = state.entries.entries().next().value;
        if (!oldest) break;
        const [oldKey, oldEntry] = oldest;
        state.entries.delete(oldKey);
        state.totalChars -= oldEntry.chars;
        if (cache.get(oldKey) === oldEntry.promise) cache.delete(oldKey);
      }
    },
    () => {
      if (cache.get(key) === pending) cache.delete(key);
    },
  );
  return pending;
}

/** `client.getFileContent` at `ref`, shared per client and byte limit. */
export function readAtRef(client: GitHubClient, owner: string, repo: string, ref: string, path: string, maxBytes?: number): Promise<string | null> {
  const suffix = maxBytes !== undefined ? `#max=${maxBytes}` : '';
  const key = JSON.stringify([owner, repo, ref, path]) + suffix;
  const start = () => client.getFileContent({
    owner, repo, path, ref, ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  return maxBytes !== undefined
    ? sharedBounded(client, key, start, MAX_LARGE_READ_CACHE_CHARS)
    : shared(readCache, client, key, start);
}

/**
 * `client.listDirectoryFiles` at `ref`, shared per client; null when the client cannot list
 * directories or the directory does not exist.
 */
export function listAtRef(client: GitHubClient, owner: string, repo: string, ref: string, path: string): Promise<string[] | null> {
  const list = client.listDirectoryFiles?.bind(client);
  if (!list) return Promise.resolve(null);
  return shared(listCache, client, `${owner}/${repo}@${ref}:${path}`, () => list({ owner, repo, path, ref }));
}

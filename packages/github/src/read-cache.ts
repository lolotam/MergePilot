import type { GitHubClient } from './client.js';

/**
 * Content at a commit never changes, so reads are shared per client: the bots of one reviewer
 * panel use the same client and read the same file at the same commit once (owner rules at the
 * base, repository context at the head). The cache lives as long as the client: the Action makes
 * one per run and the App one per job (`guardWritesForWorkspace` wraps each job's client in a new
 * object), so it never outlives a review.
 */
const readCache = new WeakMap<GitHubClient, Map<string, Promise<string | null>>>();
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

/** `client.getFileContent` at `ref`, shared per client. */
export function readAtRef(client: GitHubClient, owner: string, repo: string, ref: string, path: string): Promise<string | null> {
  return shared(readCache, client, `${owner}/${repo}@${ref}:${path}`, () => client.getFileContent({ owner, repo, path, ref }));
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

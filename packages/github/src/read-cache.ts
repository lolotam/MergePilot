import type { GitHubClient } from './client.js';

/**
 * Content at a commit never changes, so reads are shared per client: the bots of one reviewer
 * panel use the same client and read the same file at the same commit once (owner rules at the
 * base, repository context at the head). The cache lives as long as the client: the Action makes
 * one per run and the App one per job (`guardWritesForWorkspace` wraps each job's client in a new
 * object), so it never outlives a review.
 */
const readCache = new WeakMap<GitHubClient, Map<string, Promise<string | null>>>();

/** `client.getFileContent` at `ref`, shared per client; a failed read rejects for every caller. */
export function readAtRef(client: GitHubClient, owner: string, repo: string, ref: string, path: string): Promise<string | null> {
  let cache = readCache.get(client);
  if (!cache) {
    cache = new Map();
    readCache.set(client, cache);
  }
  const key = `${owner}/${repo}@${ref}:${path}`;
  let read = cache.get(key);
  if (!read) {
    read = client.getFileContent({ owner, repo, path, ref });
    cache.set(key, read);
  }
  return read;
}

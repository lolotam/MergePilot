/**
 * The repository reader of the exploration rounds (ADR-0046): the files of the pull request's own
 * repository, read at the PR head through the per-client read cache. Every path goes through the
 * review's own rules (sensitive paths, `review.exclude`, generated files, binaries, vendored
 * code) and through the path rules of the exploration (no traversal, no absolute path, no
 * `.git`), so a refused path is never even read. The path rules themselves are the engine's ones
 * (ADR-0046): there is one set of them, for the engine and for this reader.
 *
 * Nothing here runs or installs the reviewed code: blobs are read as text.
 */
import {
  isContextPathAllowed,
  isSensitivePath,
  isUnsafeExplorePath,
  normalizeExplorePath,
  type RepositoryReader,
} from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import { listAtRef, readAtRef } from './read-cache.js';

export interface RepositoryReaderParams {
  owner: string;
  repo: string;
  /** The PR head: the exploration reads the code the pull request would merge. */
  headSha: string;
  /** `review.exclude`. */
  exclude: string[];
}

/**
 * The path rules of the exploration (ADR-0046): no empty path, no absolute path, no traversal.
 * The engine owns them; this is the same rule under the name the reader uses.
 */
export function isExplorablePath(path: string): boolean {
  return !isUnsafeExplorePath(path);
}

/**
 * The reader of one review: `readFile` and `listDirectory` read at the head, `listPaths` lists
 * the blobs of the head's tree once (one call per review).
 */
export function createRepositoryReader(
  client: GitHubClient,
  params: RepositoryReaderParams,
): RepositoryReader {
  const { owner, repo, headSha, exclude } = params;
  const allowed = (path: string): boolean =>
    isExplorablePath(path) && isContextPathAllowed(path, { exclude: [...exclude], isSensitivePath });
  let treePaths: Promise<string[] | null> | undefined;

  return {
    async readFile(path: string): Promise<string | null> {
      const normalized = normalizeExplorePath(path);
      if (!allowed(normalized)) return null;
      // The content is not capped here: the engine bounds what it shows (maxLinesPerRead and the
      // read budget) and redacts it before anything of it reaches a prompt.
      return readAtRef(client, owner, repo, headSha, normalized);
    },

    async listDirectory(dir: string): Promise<string[] | null> {
      const normalized = normalizeExplorePath(dir);
      if (!allowed(`${normalized}/x`)) return null;
      const entries = await listAtRef(client, owner, repo, headSha, normalized);
      if (entries === null) return null;
      return entries.filter((entry) =>
        entry.endsWith('/') ? allowed(`${entry}x`) : allowed(entry),
      );
    },

    async listPaths(): Promise<string[] | null> {
      const list = client.listTreePaths?.bind(client);
      if (!list) return null;
      let pending = treePaths;
      if (!pending) {
        const fresh: Promise<string[] | null> = list({ owner, repo, ref: headSha });
        pending = fresh.catch((err: unknown) => {
          // A rejected listing is not kept: a later find tries again.
          if (treePaths === pending) treePaths = undefined;
          throw err;
        });
        treePaths = pending;
      }
      const paths = await pending;
      return paths === null ? null : paths.filter((path) => allowed(path));
    },
  };
}

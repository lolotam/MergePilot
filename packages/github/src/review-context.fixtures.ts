import type { GitHubClient } from './client.js';
import type { GatherContextParams } from './review-context.js';

/** A client reading `files` at the head; with `dirs`, it can also list those directories. */
export function fakeClient(
  files: Record<string, string>,
  fail: string[] = [],
  dirs?: Record<string, string[]>,
): { client: GitHubClient; reads: Array<{ path: string; ref: string }> } {
  const reads: Array<{ path: string; ref: string }> = [];
  const client = {
    getFileContent: async ({ path, ref }: { path: string; ref: string }) => {
      reads.push({ path, ref });
      if (fail.includes(path)) throw new Error('HTTP 502');
      return ref === 'head-sha' ? (files[path] ?? null) : 'BASE VERSION';
    },
    ...(dirs ? { listDirectoryFiles: async ({ path }: { path: string }) => dirs[path] ?? null } : {}),
  } as unknown as GitHubClient;
  return { client, reads };
}

export function params(files: GatherContextParams['files'], overrides: Partial<GatherContextParams> = {}): GatherContextParams {
  return { owner: 'o', repo: 'r', headSha: 'head-sha', files, exclude: [], contextTokens: 30_000, ...overrides };
}

export const modified = (path: string) => ({ path, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', changes: 2 });


import type { CompareCommitsParams, GitHubClient, GetFileContentParams } from './client.js';

export const OPTS = { owner: 'o', repo: 'r', baseSha: 'base-sha', headSha: 'head-sha' };

/** What the fake comparison answers: a merge base, or a failure. */
export type FakeCompare = { mergeBaseSha?: string } | 'fail';

/** A client whose contents API answers from a map of `ref:path` to content. */
export function fakeClient(
  contents: Record<string, string>,
  listings: Record<string, string[]> = {},
  compare?: FakeCompare,
): { client: GitHubClient; reads: string[]; lists: string[]; compares: string[] } {
  const reads: string[] = [];
  const lists: string[] = [];
  const compares: string[] = [];
  const client = {
    async getFileContent({ path, ref }: GetFileContentParams) {
      reads.push(`${ref}:${path}`);
      return contents[`${ref}:${path}`] ?? null;
    },
    async listDirectoryFiles({ path, ref }: GetFileContentParams) {
      lists.push(`${ref}:${path}`);
      return listings[`${ref}:${path}`] ?? null;
    },
    ...(compare
      ? {
          async compareCommits({ base, head }: CompareCommitsParams) {
            compares.push(`${base}...${head}`);
            if (compare === 'fail') throw new Error('the comparison failed');
            return {
              status: 'ahead' as const,
              files: [],
              ...(compare.mergeBaseSha ? { mergeBaseSha: compare.mergeBaseSha } : {}),
            };
          },
        }
      : {}),
  } as unknown as GitHubClient;
  return { client, reads, lists, compares };
}

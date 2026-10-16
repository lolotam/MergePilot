/**
 * Review thread state (ADR-0030). REST review comments do not say whether their thread was
 * resolved; GraphQL `reviewThreads` does. Both GitHub clients (the Action's and the App's) page it
 * here with their own `graphql` function, so the query and its parsing live once.
 */
import type { GitHubReviewThread, ListReviewThreadsParams } from './client-types.js';

export const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId fullDatabaseId } } }
      }
    }
  }
}`;

/** At most this many pages of 100 threads; a PR with more fails the read, so it is disclosed as not re-checked. */
const MAX_THREAD_PAGES = 10;

/** A GraphQL call: `octokit.graphql` in both clients. */
export type GraphqlRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

interface ReviewThreadsPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{
          isResolved?: boolean;
          comments?: { nodes?: Array<{ databaseId?: number | null; fullDatabaseId?: string | null } | null> };
        } | null>;
      } | null;
    } | null;
  } | null;
}

/**
 * The REST id of a thread's first comment. `fullDatabaseId` (a BigInt as a string) holds ids past
 * 2^31-1, which review comment ids have reached; `databaseId` (a 32-bit Int) is the fallback.
 */
function firstCommentIdOf(comment: { databaseId?: number | null; fullDatabaseId?: string | null } | null | undefined): number | null {
  const full = comment?.fullDatabaseId ? Number(comment.fullDatabaseId) : NaN;
  if (Number.isSafeInteger(full)) return full;
  return comment?.databaseId ?? null;
}

/** Every review thread of a pull request: resolved or not, and the id of its first comment. */
export async function fetchReviewThreads(graphql: GraphqlRequest, params: ListReviewThreadsParams): Promise<GitHubReviewThread[]> {
  const threads: GitHubReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data = (await graphql(REVIEW_THREADS_QUERY, {
      owner: params.owner,
      repo: params.repo,
      number: params.pull_number,
      cursor,
    })) as ReviewThreadsPage;
    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection) break;
    for (const node of connection.nodes ?? []) {
      if (!node) continue;
      threads.push({ isResolved: node.isResolved === true, firstCommentId: firstCommentIdOf(node.comments?.nodes?.[0]) });
    }
    // Only a page that says it is the last may end the read: a list cut short drops open findings.
    if (!connection.pageInfo?.hasNextPage) return threads;
    if (!connection.pageInfo.endCursor) throw new Error('review threads: a next page without a cursor');
    cursor = connection.pageInfo.endCursor;
  }
  // More threads than the page limit: a partial list would silently drop open findings.
  if (cursor !== null) throw new Error(`review threads exceed ${MAX_THREAD_PAGES * 100}`);
  return threads;
}

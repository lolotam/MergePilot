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
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

/** At most this many pages of 100 threads; a thread past them counts as not found (not shown). */
const MAX_THREAD_PAGES = 10;

/** A GraphQL call: `octokit.graphql` in both clients. */
export type GraphqlRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

interface ReviewThreadsPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{ isResolved?: boolean; comments?: { nodes?: Array<{ databaseId?: number | null } | null> } } | null>;
      } | null;
    } | null;
  } | null;
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
      threads.push({ isResolved: node.isResolved === true, firstCommentId: node.comments?.nodes?.[0]?.databaseId ?? null });
    }
    if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    cursor = connection.pageInfo.endCursor;
  }
  return threads;
}

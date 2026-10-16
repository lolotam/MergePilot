import { describe, expect, it } from 'vitest';
import { fetchReviewThreads, REVIEW_THREADS_QUERY, type GraphqlRequest } from './review-threads.js';

// ADR-0030: the thread state of review comments comes from GraphQL, page by page.

function page(nodes: unknown[], endCursor: string | null): unknown {
  return {
    repository: {
      pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
    },
  };
}

describe('fetchReviewThreads', () => {
  it('pages through the threads and keeps each first comment id with its resolution', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      page([{ isResolved: false, comments: { nodes: [{ databaseId: 11 }] } }, null], 'cursor-1'),
      page([{ isResolved: true, comments: { nodes: [{ databaseId: 12 }] } }, { isResolved: false, comments: { nodes: [] } }], null),
    ];
    const graphql: GraphqlRequest = async (query, variables) => {
      expect(query).toBe(REVIEW_THREADS_QUERY);
      calls.push(variables);
      return pages.shift();
    };

    const threads = await fetchReviewThreads(graphql, { owner: 'o', repo: 'r', pull_number: 5 });

    expect(threads).toEqual([
      { isResolved: false, firstCommentId: 11 },
      { isResolved: true, firstCommentId: 12 },
      { isResolved: false, firstCommentId: null },
    ]);
    expect(calls).toEqual([
      { owner: 'o', repo: 'r', number: 5, cursor: null },
      { owner: 'o', repo: 'r', number: 5, cursor: 'cursor-1' },
    ]);
  });

  it('reads ids past 2^31-1 from fullDatabaseId', async () => {
    const graphql: GraphqlRequest = async () =>
      page([{ isResolved: false, comments: { nodes: [{ databaseId: null, fullDatabaseId: '4297107815' }] } }], null);
    expect(await fetchReviewThreads(graphql, { owner: 'o', repo: 'r', pull_number: 5 })).toEqual([
      { isResolved: false, firstCommentId: 4297107815 },
    ]);
  });

  it('fails instead of returning a partial list when the threads exceed the page limit', async () => {
    let n = 0;
    const graphql: GraphqlRequest = async () => page([{ isResolved: false, comments: { nodes: [{ databaseId: ++n }] } }], `c${n}`);
    await expect(fetchReviewThreads(graphql, { owner: 'o', repo: 'r', pull_number: 5 })).rejects.toThrow(/exceed/);
  });

  it('returns no thread when the pull request is not found', async () => {
    expect(await fetchReviewThreads(async () => ({ repository: null }), { owner: 'o', repo: 'r', pull_number: 5 })).toEqual([]);
  });
});

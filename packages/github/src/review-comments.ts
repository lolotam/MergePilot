import type { GitHubClient, GitHubReviewComment } from './client.js';

const COMMENTS_PAGE_SIZE = 100;

/**
 * Every inline review comment of a pull request, page by page (duplicate check, open findings).
 * Empty when the client cannot list them; throws when a page cannot be read.
 */
export async function listAllReviewComments(
  client: GitHubClient,
  params: { owner: string; repo: string; pull_number: number },
): Promise<GitHubReviewComment[]> {
  if (!client.listReviewCommentsPage) return [];
  const all: GitHubReviewComment[] = [];
  for (let page = 1; ; page++) {
    const comments = await client.listReviewCommentsPage({ ...params, page, per_page: COMMENTS_PAGE_SIZE });
    all.push(...comments);
    if (comments.length < COMMENTS_PAGE_SIZE) return all;
  }
}

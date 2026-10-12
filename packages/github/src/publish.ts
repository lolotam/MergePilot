import type { Finding } from '@mergepilot/engine';
import type { GitHubClient, GitHubDraftReviewComment } from './client.js';
import { deduplicateFindings } from './dedupe.js';
import { buildMarker, parseMarker } from './marker.js';
import { renderFindingComment } from './render.js';

export interface PublishReviewParams {
  owner: string;
  repo: string;
  pull_number: number;
  expectedHeadSha: string;
  summaryMarkdown: string;
  inline: Finding[];
  configHash: string;
  language: 'ar' | 'en';
  suggestionsAsCode: boolean;
  /**
   * Login of the account MergePilot posts as (e.g. `github-actions[bot]`). Only its reviews
   * count as duplicates, so a marker pasted by anyone else cannot suppress a review.
   */
  publisherLogin: string;
  /** Marks the review as not completed (failed/budget), so it never anchors an incremental review. */
  partial?: boolean | undefined;
  /** Set when the caller already dropped duplicates (avoids fetching the PR's comments twice). */
  alreadyDeduplicated?: boolean | undefined;
}

export type PublishReviewResult =
  | { status: 'skipped-stale' }
  | { status: 'skipped-duplicate'; reviewId: number }
  | { status: 'skipped-paused' }
  | { status: 'skipped-no-changes' }
  | { status: 'published'; reviewId: number };

const REVIEWS_PAGE_SIZE = 100;

/**
 * Publishes a code review to GitHub idempotently.
 * Checks for stale head commits or existing reviews carrying the head marker before posting.
 */
export async function publishReview(
  client: GitHubClient,
  {
    owner,
    repo,
    pull_number,
    expectedHeadSha,
    summaryMarkdown,
    inline,
    configHash,
    language,
    suggestionsAsCode,
    publisherLogin,
    partial,
    alreadyDeduplicated,
  }: PublishReviewParams,
): Promise<PublishReviewResult> {
  const pr = await client.getPullRequest({ owner, repo, pull_number });
  if (pr.head.sha !== expectedHeadSha) {
    return { status: 'skipped-stale' };
  }

  let page = 1;
  while (true) {
    const reviews = await client.listReviewsPage({
      owner,
      repo,
      pull_number,
      page,
      per_page: REVIEWS_PAGE_SIZE,
    });

    for (const review of reviews) {
      if (review.body && review.user?.login === publisherLogin) {
        const marker = parseMarker(review.body);
        if (marker && marker.headSha === expectedHeadSha) {
          return { status: 'skipped-duplicate', reviewId: review.id };
        }
      }
    }

    if (reviews.length < REVIEWS_PAGE_SIZE) {
      break;
    }
    page++;
  }

  const marker = buildMarker({
    headSha: expectedHeadSha,
    configHash,
    ...(partial ? { status: 'partial' as const } : {}),
  });
  const trimmedSummary = summaryMarkdown.trimEnd();
  const body = trimmedSummary ? `${trimmedSummary}\n\n${marker}` : marker;

  const dedupedInline = alreadyDeduplicated
    ? inline
    : (
        await deduplicateFindings(client, {
          owner,
          repo,
          pull_number,
          publisherLogin,
          findings: inline,
        })
      ).kept;

  const comments: GitHubDraftReviewComment[] = dedupedInline.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: finding.side,
    body: renderFindingComment(finding, { language, suggestionsAsCode }),
  }));

  const createdReview = await client.createReview({
    owner,
    repo,
    pull_number,
    commit_id: expectedHeadSha,
    event: 'COMMENT',
    body,
    comments,
  });

  return {
    status: 'published',
    reviewId: createdReview.id,
  };
}

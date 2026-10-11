import type { GitHubClient } from './client.js';
import { parseMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';

export interface FindLastReviewedHeadOptions {
  owner: string;
  repo: string;
  pull_number: number;
  publisherLogin: string;
}

export interface SelectIncrementalFilesOptions {
  owner: string;
  repo: string;
  pull_number: number;
  headSha: string;
  publisherLogin: string;
  prFiles: PullRequestFile[];
}

export type SelectIncrementalFilesResult =
  | { mode: 'full'; files: PullRequestFile[]; reason: string }
  | { mode: 'incremental'; files: PullRequestFile[]; sinceSha: string };

const REVIEWS_PAGE_SIZE = 100;

/**
 * Finds the head SHA from the hidden MergePilot marker of the most recent review
 * authored by publisherLogin, or null if no such review exists.
 */
export async function findLastReviewedHead(
  client: GitHubClient,
  { owner, repo, pull_number, publisherLogin }: FindLastReviewedHeadOptions,
): Promise<string | null> {
  let page = 1;
  let lastHeadSha: string | null = null;

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
        if (marker?.headSha) {
          lastHeadSha = marker.headSha;
        }
      }
    }

    if (reviews.length < REVIEWS_PAGE_SIZE) {
      break;
    }
    page++;
  }

  return lastHeadSha;
}

/**
 * Determines whether to run a full or incremental review based on past review markers and git commit history.
 *
 * - No previous review: full ("first review")
 * - Same head: incremental with 0 files (skip)
 * - Ahead: incremental with intersecting files between compare and prFiles, using compare patch
 * - Diverged, behind, or 404: full ("history rewritten since last review")
 */
export async function selectIncrementalFiles(
  client: GitHubClient,
  {
    owner,
    repo,
    pull_number,
    headSha,
    publisherLogin,
    prFiles,
  }: SelectIncrementalFilesOptions,
): Promise<SelectIncrementalFilesResult> {
  const lastReviewedHead = await findLastReviewedHead(client, {
    owner,
    repo,
    pull_number,
    publisherLogin,
  });

  if (lastReviewedHead === null) {
    return {
      mode: 'full',
      files: prFiles,
      reason: 'first review',
    };
  }

  if (lastReviewedHead === headSha) {
    return {
      mode: 'incremental',
      files: [],
      sinceSha: headSha,
    };
  }

  const comparison = await client.compareCommits({
    owner,
    repo,
    base: lastReviewedHead,
    head: headSha,
  });

  if (!comparison || comparison.status !== 'ahead') {
    return {
      mode: 'full',
      files: prFiles,
      reason: 'history rewritten since last review',
    };
  }

  const prFileMap = new Map(prFiles.map((file) => [file.path, file]));
  const files: PullRequestFile[] = [];

  for (const compareFile of comparison.files) {
    const prFile = prFileMap.get(compareFile.filename);
    if (!prFile) {
      continue;
    }

    const mapped: PullRequestFile = {
      path: compareFile.filename,
      status: compareFile.status ?? prFile.status,
      additions: compareFile.additions ?? prFile.additions,
      deletions: compareFile.deletions ?? prFile.deletions,
      changes: compareFile.changes ?? prFile.changes,
    };

    if (compareFile.patch !== undefined) {
      mapped.patch = compareFile.patch;
    }
    const previousPath = compareFile.previous_filename ?? prFile.previousPath;
    if (previousPath !== undefined) {
      mapped.previousPath = previousPath;
    }

    files.push(mapped);
  }

  return {
    mode: 'incremental',
    files,
    sinceSha: lastReviewedHead,
  };
}

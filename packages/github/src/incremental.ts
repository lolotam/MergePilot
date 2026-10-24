import type { CompareCommitsResult, GitHubClient } from './client.js';
import { MAIN_BOT_SLOT, markerBotSlot, parseMarker, type ReviewMarker } from './marker.js';
import { withoutBaseHunks } from './own-hunks.js';
import type { PullRequestFile } from './pr-files.js';
import type { ReviewScope } from './summary.js';

export interface FindLastReviewedHeadOptions {
  owner: string;
  repo: string;
  pull_number: number;
  publisherLogin: string;
  /** The reviewer-panel bot (ADR-0017), default 1: only its own reviews are a base. */
  botSlot?: number | undefined;
}

export interface SelectIncrementalFilesOptions {
  owner: string;
  repo: string;
  pull_number: number;
  headSha: string;
  publisherLogin: string;
  prFiles: PullRequestFile[];
  configHash?: string;
  /** The reviewer-panel bot (ADR-0017), default 1. */
  botSlot?: number | undefined;
  /**
   * The PR's base commit. When given, hunks a base-branch merge brought in since the last review
   * are left out (ADR-0012 amendment); without it every hunk of the range is reviewed.
   */
  baseSha?: string | undefined;
  /** `@mergepilot review` asked for it: the whole PR is reviewed, whatever was reviewed before. */
  force?: boolean | undefined;
}

/** The scope reason shown when a review was asked for with `@mergepilot review`. */
export const REVIEW_REQUESTED_REASON = 'review requested';

export type SelectIncrementalFilesResult =
  | { mode: 'full'; files: PullRequestFile[]; reason: string }
  | { mode: 'incremental'; files: PullRequestFile[]; sinceSha: string; commitCount?: number };

const REVIEWS_PAGE_SIZE = 100;
const MAX_COMPARE_FILES = 300;

/** A drizzle migration snapshot: `packages/db/migrations/meta/0175_snapshot.json`. */
const SNAPSHOT_PATH_RE = /(^|\/)migrations\/meta\/(\d+)_snapshot\.json$/;

/**
 * Finds the hidden MergePilot marker of the most recent review
 * authored by publisherLogin, or null if no such review exists.
 */
export async function findLastReviewedMarker(
  client: GitHubClient,
  { owner, repo, pull_number, publisherLogin, botSlot = MAIN_BOT_SLOT }: FindLastReviewedHeadOptions,
): Promise<ReviewMarker | null> {
  let page = 1;
  let lastMarker: ReviewMarker | null = null;

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
        // A partial (failed / budget-skipped) review did not cover its commits: never a base.
        if (marker?.headSha && marker.status !== 'partial' && markerBotSlot(marker) === botSlot) {
          lastMarker = marker;
        }
      }
    }

    if (reviews.length < REVIEWS_PAGE_SIZE) {
      break;
    }
    page++;
  }

  return lastMarker;
}

/**
 * Finds the head SHA from the hidden MergePilot marker of the most recent review
 * authored by publisherLogin, or null if no such review exists.
 */
export async function findLastReviewedHead(
  client: GitHubClient,
  options: FindLastReviewedHeadOptions,
): Promise<string | null> {
  const marker = await findLastReviewedMarker(client, options);
  return marker ? marker.headSha : null;
}

/**
 * Determines whether to run a full or incremental review based on past review markers and git commit history.
 *
 * - No previous review: full ("first review")
 * - Config hash changed: full ("configuration changed since last review")
 * - Same head: incremental with 0 files (nothing new to review)
 * - Ahead: incremental with intersecting files between compare and prFiles, using the compare
 *   patch without the hunks proven to come from a base-branch merge (needs `baseSha`)
 * - Ahead, but a compared file has no patch (its diff was too big for the compare API): full
 *   ("the new changes of <path> are too large for the compare API")
 * - Compare at GitHub's 300-file cap (possibly truncated): full ("comparison too large")
 * - Compare error: full ("comparison unavailable")
 * - Diverged, behind, or 404: full ("history rewritten since last review")
 * - Partial (failed / budget-skipped) reviews are never used as the base.
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
    configHash,
    botSlot,
    baseSha,
    force,
  }: SelectIncrementalFilesOptions,
): Promise<SelectIncrementalFilesResult> {
  if (force) return { mode: 'full', files: prFiles, reason: REVIEW_REQUESTED_REASON };

  const lastMarker = await findLastReviewedMarker(client, {
    owner,
    repo,
    pull_number,
    publisherLogin,
    botSlot,
  });

  if (lastMarker === null) {
    return {
      mode: 'full',
      files: prFiles,
      reason: 'first review',
    };
  }

  if (configHash && lastMarker.configHash !== configHash) {
    return {
      mode: 'full',
      files: prFiles,
      reason: 'configuration changed since last review',
    };
  }

  if (lastMarker.headSha === headSha) {
    return {
      mode: 'incremental',
      files: [],
      sinceSha: headSha,
    };
  }

  let comparison: CompareCommitsResult | null;
  try {
    comparison = await client.compareCommits({
      owner,
      repo,
      base: lastMarker.headSha,
      head: headSha,
    });
  } catch {
    // Any compare failure (timeout, 5xx, diff too large to compute) falls back to a full review.
    return { mode: 'full', files: prFiles, reason: 'comparison unavailable' };
  }

  if (!comparison || comparison.status !== 'ahead') {
    return {
      mode: 'full',
      files: prFiles,
      reason: 'history rewritten since last review',
    };
  }

  // GitHub's compare returns at most 300 files: a response at the cap may be truncated.
  if (comparison.files.length >= MAX_COMPARE_FILES) {
    return {
      mode: 'full',
      files: prFiles,
      reason: 'comparison too large',
    };
  }

  const prFileMap = new Map(prFiles.map((file) => [file.path, file]));
  const basePatches = await baseBranchPatches(client, { owner, repo, since: lastMarker.headSha, baseSha }, comparison, prFileMap);
  const files: PullRequestFile[] = [];

  for (const compareFile of comparison.files) {
    const prFile = prFileMap.get(compareFile.filename);
    if (!prFile) {
      continue;
    }

    const status = compareFile.status ?? prFile.status;
    const mapped: PullRequestFile = {
      path: compareFile.filename,
      status,
      additions: compareFile.additions ?? prFile.additions,
      deletions: compareFile.deletions ?? prFile.deletions,
      changes: compareFile.changes ?? prFile.changes,
    };

    const isSnapshot = status === 'added' && SNAPSHOT_PATH_RE.test(compareFile.filename);
    if (isSnapshot && prFile.patch !== undefined) {
      // A snapshot's patch is the diff against its previous snapshot (ADR-0045, rule 5): the
      // compare API's patch is the whole new file, so the rebuilt one is reviewed instead.
      mapped.patch = prFile.patch;
    } else if (compareFile.patch !== undefined) {
      // A base-branch merge brings in changes the PR did not make: those hunks are left out.
      const own = withoutBaseHunks(compareFile.patch, basePatches.get(compareFile.filename), prFile.patch);
      if (own === undefined) continue;
      mapped.patch = own;
    } else if (!isSnapshot) {
      // The compare API left the patch out (its diff was too big for it). The pull request's own
      // patch covers the changes from before the last reviewed commit too, so it is not shown as
      // new: the whole pull request is reviewed instead.
      return {
        mode: 'full',
        files: prFiles,
        reason: `the new changes of ${compareFile.filename} are too large for the compare API`,
      };
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
    sinceSha: lastMarker.headSha,
    ...(comparison.totalCommits !== undefined ? { commitCount: comparison.totalCommits } : {}),
  };
}

/**
 * The base branch's own patch per file since the last reviewed head (`since...baseSha`: what a
 * merge of the base branch can bring in), for the PR files the range touches. Empty when there is
 * no base commit, nothing to check, or the comparison fails: then no hunk is left out.
 */
async function baseBranchPatches(
  client: GitHubClient,
  { owner, repo, since, baseSha }: { owner: string; repo: string; since: string; baseSha: string | undefined },
  comparison: CompareCommitsResult,
  prFileMap: ReadonlyMap<string, PullRequestFile>,
): Promise<Map<string, string>> {
  const patches = new Map<string, string>();
  if (!baseSha || !comparison.files.some((f) => f.patch !== undefined && prFileMap.has(f.filename))) return patches;
  let base: CompareCommitsResult | null;
  try {
    base = await client.compareCommits({ owner, repo, base: since, head: baseSha });
  } catch {
    return patches;
  }
  for (const file of base?.files ?? []) {
    if (file.patch !== undefined) patches.set(file.filename, file.patch);
  }
  return patches;
}

/** The scope line shown in the review summary for a file selection. */
export function reviewScopeOf(selection: SelectIncrementalFilesResult): ReviewScope {
  if (selection.mode === 'incremental') {
    return {
      mode: 'incremental',
      sinceSha: selection.sinceSha,
      ...(selection.commitCount !== undefined ? { commitCount: selection.commitCount } : {}),
    };
  }
  return { mode: 'full', reason: selection.reason };
}

/**
 * True when an incremental selection has nothing to review: the head was already reviewed, or
 * the new commits touch no file of the PR diff (e.g. a base-branch merge). No model is called and
 * nothing is published; the next push is compared against the same reviewed head.
 */
export function hasNothingNewToReview(selection: SelectIncrementalFilesResult): boolean {
  return selection.mode === 'incremental' && selection.files.length === 0;
}

export const NOTHING_NEW_DETAIL = 'no new changes since the last review';

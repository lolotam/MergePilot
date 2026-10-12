import { createHash } from 'node:crypto';
import type { Finding } from '@mergepilot/engine';
import type { GitHubClient, GitHubReviewComment } from './client.js';

export interface DeduplicateFindingsParams {
  owner: string;
  repo: string;
  pull_number: number;
  publisherLogin: string;
  findings: Finding[];
}

export interface DeduplicateFindingsResult {
  kept: Finding[];
  dropped: Finding[];
  /** True when existing comments could not be read, so nothing was filtered. */
  skipped?: boolean;
}

const COMMENTS_PAGE_SIZE = 100;
const FINGERPRINT_REGEX = /<!--\s*mp:f=([a-f0-9]+)\s*-->/i;
const TITLE_REGEX = /^###\s+(.+)$/m;

/**
 * Normalizes finding titles for robust fingerprinting and similarity matching:
 * trimmed, lowercase, stripped of non-alphanumeric/non-space unicode characters, collapsed whitespace.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * Computes a stable fingerprint for an inline finding based on path, rule, and normalized title.
 * Formatted as `<!-- mp:f=<16-char-hash> -->` inside comments.
 */
export function computeFindingFingerprint(finding: Finding): string {
  const normTitle = normalizeTitle(finding.title);
  const rule = finding.ruleRef ?? '';
  const payload = `${finding.path}:${rule}:${normTitle}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Parses the hidden fingerprint from a review comment body, or null if absent.
 */
export function parseFingerprintFromComment(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(FINGERPRINT_REGEX);
  return match && match[1] ? match[1].toLowerCase() : null;
}

/**
 * Parses the finding title from a markdown review comment heading (`### Title`), or null if absent.
 */
export function parseTitleFromComment(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(TITLE_REGEX);
  return match && match[1] ? match[1].trim() : null;
}

/**
 * Checks whether two finding titles are near-identical (normalized match or high token overlap).
 */
export function areTitlesSimilar(title1: string, title2: string): boolean {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);
  if (!norm1 || !norm2) return false;
  if (norm1 === norm2) return true;

  const words1 = new Set(norm1.split(' ').filter(Boolean));
  const words2 = new Set(norm2.split(' ').filter(Boolean));
  if (words1.size === 0 || words2.size === 0) return false;

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  const union = new Set([...words1, ...words2]).size;
  const similarity = intersection / union;
  return similarity >= 0.7;
}

interface LineRange {
  start: number;
  end: number;
}

function commentLineRange(comment: GitHubReviewComment): LineRange | null {
  const line = comment.line ?? comment.original_line;
  if (line === null || line === undefined) return null;
  const startLine = comment.start_line ?? comment.original_start_line ?? line;
  return {
    start: Math.min(startLine, line),
    end: Math.max(startLine, line),
  };
}

/**
 * A comment counts as MergePilot's when posted by this publisher, or by another bot account
 * (the Action's `github-actions[bot]` vs the App's `<slug>[bot]`) and carrying a fingerprint
 * marker, so the Action and the SaaS never repeat each other. A human pasting a marker cannot
 * suppress findings: only bot accounts are trusted for the cross-path match.
 */
function isMergePilotComment(comment: GitHubReviewComment, publisherLogin: string): boolean {
  if (!comment.body) return false;
  const login = comment.user?.login;
  if (!login) return false;
  if (login === publisherLogin) return true;
  return login.endsWith('[bot]') && FINGERPRINT_REGEX.test(comment.body);
}

function rangesOverlap(r1: LineRange, r2: LineRange): boolean {
  return r1.start <= r2.end && r1.end >= r2.start;
}

/**
 * Fetches existing MergePilot review comments on the pull request and drops new findings
 * that duplicate an already published comment (same path, overlapping line range, and
 * matching fingerprint or similar title).
 */
export async function deduplicateFindings(
  client: GitHubClient,
  { owner, repo, pull_number, publisherLogin, findings }: DeduplicateFindingsParams,
): Promise<DeduplicateFindingsResult> {
  if (findings.length === 0) {
    return { kept: [], dropped: [] };
  }

  if (!client.listReviewCommentsPage) {
    return { kept: [...findings], dropped: [] };
  }

  // Paged fetch of all MergePilot review comments on the PR
  let page = 1;
  const existingComments: GitHubReviewComment[] = [];

  while (true) {
    let comments: GitHubReviewComment[];
    try {
      comments = await client.listReviewCommentsPage({
        owner,
        repo,
        pull_number,
        page,
        per_page: COMMENTS_PAGE_SIZE,
      });
    } catch {
      // Dedupe is best-effort: losing it must never lose a review the model already paid for.
      return { kept: [...findings], dropped: [], skipped: true };
    }

    for (const comment of comments) {
      if (isMergePilotComment(comment, publisherLogin)) {
        existingComments.push(comment);
      }
    }

    if (comments.length < COMMENTS_PAGE_SIZE) {
      break;
    }
    page++;
  }

  if (existingComments.length === 0) {
    return { kept: [...findings], dropped: [] };
  }

  // Map existing comments for fast matching
  const commentsByPath = new Map<
    string,
    Array<{
      range: LineRange;
      fingerprint: string | null;
      title: string | null;
    }>
  >();

  for (const comment of existingComments) {
    const range = commentLineRange(comment);
    if (!range) continue;
    const path = comment.path;
    const fingerprint = parseFingerprintFromComment(comment.body);
    const title = parseTitleFromComment(comment.body);

    const list = commentsByPath.get(path) ?? [];
    list.push({ range, fingerprint, title });
    commentsByPath.set(path, list);
  }

  const kept: Finding[] = [];
  const dropped: Finding[] = [];

  for (const finding of findings) {
    const existing = commentsByPath.get(finding.path);
    if (!existing || existing.length === 0) {
      kept.push(finding);
      continue;
    }

    const findingRange: LineRange = { start: finding.line, end: finding.line };
    const findingFingerprint = computeFindingFingerprint(finding);

    const isDuplicate = existing.some((ex) => {
      if (!rangesOverlap(findingRange, ex.range)) {
        return false;
      }

      // 1. Stable fingerprint (path + rule + normalized title).
      if (ex.fingerprint !== null && ex.fingerprint === findingFingerprint) {
        return true;
      }

      // 2. Title similarity: legacy comments without a fingerprint, and a model that reworded
      //    the same finding on the same lines (its fingerprint then differs).
      return ex.title !== null && areTitlesSimilar(ex.title, finding.title);
    });

    if (isDuplicate) {
      dropped.push(finding);
    } else {
      kept.push(finding);
    }
  }

  return { kept, dropped };
}

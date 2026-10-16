import { createHash } from 'node:crypto';
import { judgeSameIssue, type Finding, type Judge, type SameIssuePair, type Secret } from '@mergepilot/engine';
import type { GitHubClient, GitHubReviewComment } from './client.js';
import { commentBotSlot, MAIN_BOT_SLOT } from './marker.js';
import { listAllReviewComments } from './review-comments.js';

export interface DeduplicateFindingsParams {
  owner: string;
  repo: string;
  pull_number: number;
  publisherLogin: string;
  findings: Finding[];
  /**
   * Optional Jev judge (ADR-0015): when fingerprint and title do not match, asks whether a new
   * finding and a nearby existing MergePilot comment describe the same issue.
   */
  judge?: Judge | undefined;
  knownSecrets?: readonly Secret[] | undefined;
  /** Spend still allowed for the judge call. */
  maxUsd?: number | undefined;
  /**
   * The reviewer-panel bot (ADR-0017), default 1: only its own comments count. A comment without
   * a bot marker belongs to slot 1.
   */
  botSlot?: number | undefined;
}

export interface SemanticDedupeResult {
  checked: number;
  dropped: number;
  unavailable?: string | undefined;
}

export interface DeduplicateFindingsResult {
  kept: Finding[];
  dropped: Finding[];
  /** True when existing comments could not be read, so nothing was filtered. */
  skipped?: boolean;
  /** Set when the Jev semantic check ran (or failed). */
  semantic?: SemanticDedupeResult | undefined;
}

/** Existing comments within this many lines of a new finding are semantic-check candidates. */
export const SEMANTIC_LINE_WINDOW = 10;
const MAX_CANDIDATES_PER_FINDING = 3;
const MAX_SEMANTIC_PAIRS = 50;

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
  { owner, repo, pull_number, publisherLogin, findings, judge, knownSecrets = [], maxUsd, botSlot = MAIN_BOT_SLOT }: DeduplicateFindingsParams,
): Promise<DeduplicateFindingsResult> {
  if (findings.length === 0) {
    return { kept: [], dropped: [] };
  }

  if (!client.listReviewCommentsPage) {
    return { kept: [...findings], dropped: [] };
  }

  // Every MergePilot review comment of this bot on the PR.
  let comments: GitHubReviewComment[];
  try {
    comments = await listAllReviewComments(client, { owner, repo, pull_number });
  } catch {
    // Dedupe is best-effort: losing it must never lose a review the model already paid for.
    return { kept: [...findings], dropped: [], skipped: true };
  }
  const existingComments = comments.filter(
    (comment) => isMergePilotComment(comment, publisherLogin) && commentBotSlot(comment.body) === botSlot,
  );

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
      body: string;
    }>
  >();

  for (const comment of existingComments) {
    const range = commentLineRange(comment);
    if (!range) continue;
    const path = comment.path;
    const fingerprint = parseFingerprintFromComment(comment.body);
    const title = parseTitleFromComment(comment.body);

    const list = commentsByPath.get(path) ?? [];
    list.push({ range, fingerprint, title, body: (comment.body ?? '').replace(FINGERPRINT_REGEX, '').trim() });
    commentsByPath.set(path, list);
  }

  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  const pairs: SameIssuePair[] = [];
  const pairFinding = new Map<string, Finding>();

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
      continue;
    }
    kept.push(finding);
    if (!judge) continue;
    // 3. Semantic check (Jev): only nearby comments the cheap checks did not match.
    const nearby = existing
      .map((ex) => ({ ex, distance: lineDistance(finding.line, ex.range) }))
      .filter((c) => c.distance <= SEMANTIC_LINE_WINDOW)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_CANDIDATES_PER_FINDING);
    for (const { ex } of nearby) {
      if (pairs.length >= MAX_SEMANTIC_PAIRS) break;
      const key = `${finding.id}#${pairs.length}`;
      pairFinding.set(key, finding);
      pairs.push({
        key,
        newComment: { path: finding.path, line: finding.line, title: finding.title, body: finding.body },
        existingComment: { path: finding.path, line: ex.range.start, body: ex.body },
      });
    }
  }

  if (!judge || pairs.length === 0) return { kept, dropped };

  const outcome = await judgeSameIssue({ judge, pairs, knownSecrets, maxUsd });
  const semanticDuplicates = new Set<Finding>();
  for (const key of outcome.duplicates) {
    const finding = pairFinding.get(key);
    if (finding) semanticDuplicates.add(finding);
  }
  return {
    kept: kept.filter((f) => !semanticDuplicates.has(f)),
    dropped: [...dropped, ...semanticDuplicates],
    semantic: {
      checked: outcome.checked,
      dropped: semanticDuplicates.size,
      ...(outcome.unavailable ? { unavailable: outcome.unavailable } : {}),
    },
  };
}

function lineDistance(line: number, range: LineRange): number {
  if (line < range.start) return range.start - line;
  if (line > range.end) return line - range.end;
  return 0;
}

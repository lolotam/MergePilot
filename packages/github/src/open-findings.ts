/**
 * The bot's own findings whose review threads are still open (ADR-0030). A follow-up review shows
 * them to the model, so it can say which ones the new changes fix and not report them again.
 *
 * Only this bot's comments count: posted by the publisher, carrying the `mp:f` finding marker, on
 * this panel slot. A thread counts as open only when GitHub says so (GraphQL `isResolved`); when the
 * thread state cannot be read, nothing is shown and the summary says so. Nothing is resolved here.
 */
import { OPEN_FINDINGS_MAX, type OpenFinding } from '@mergepilot/engine';
import type { GitHubClient, GitHubReviewComment } from './client.js';
import { parseFingerprintFromComment, parseTitleFromComment } from './dedupe.js';
import { commentBotSlot, MAIN_BOT_SLOT } from './marker.js';
import { listAllReviewComments } from './review-comments.js';

export interface GatherOpenFindingsParams {
  owner: string;
  repo: string;
  pull_number: number;
  publisherLogin: string;
  /** The panel slot whose comments count (ADR-0017), default 1. */
  botSlot?: number | undefined;
}

export interface GatheredOpenFindings {
  /** The newest {@link OPEN_FINDINGS_MAX}, listed by path then line. */
  findings: OpenFinding[];
  /** How many of the bot's findings are open, those past the cap included. */
  total: number;
  /** The thread state could not be read: no open finding is shown. */
  unchecked: boolean;
}

const UNCHECKED: GatheredOpenFindings = { findings: [], total: 0, unchecked: true };

/** Where the comment body stops being the finding: its evidence and suggestion are not repeated. */
const EVIDENCE_LABEL_RE = /\*\*(?:Evidence|الدليل):\*\*/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEADING_RE = /^###\s+.+$/m;

/** The finding part of an inline comment: no heading, markers, evidence or suggestion. */
function findingText(body: string): string {
  const withoutMarkers = body.replace(HTML_COMMENT_RE, '').replace(HEADING_RE, '');
  const evidenceAt = withoutMarkers.search(EVIDENCE_LABEL_RE);
  return (evidenceAt >= 0 ? withoutMarkers.slice(0, evidenceAt) : withoutMarkers).trim();
}

function toOpenFinding(comment: GitHubReviewComment): OpenFinding {
  return {
    id: String(comment.id),
    path: comment.path,
    ...(typeof comment.line === 'number' ? { line: comment.line } : {}),
    title: parseTitleFromComment(comment.body) ?? 'Finding',
    body: findingText(comment.body),
  };
}

const byPlace = (a: OpenFinding, b: OpenFinding): number =>
  (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);

async function readOpenFindings(client: GitHubClient, params: GatherOpenFindingsParams): Promise<GatheredOpenFindings> {
  if (!client.listReviewCommentsPage || !client.listReviewThreads) return UNCHECKED;
  const { owner, repo, pull_number } = params;
  let comments: GitHubReviewComment[];
  let openThreadRoots: Set<number>;
  try {
    const [all, threads] = await Promise.all([
      listAllReviewComments(client, { owner, repo, pull_number }),
      client.listReviewThreads({ owner, repo, pull_number }),
    ]);
    comments = all;
    openThreadRoots = new Set(threads.flatMap((t) => (!t.isResolved && t.firstCommentId !== null ? [t.firstCommentId] : [])));
  } catch {
    // Reading threads is best-effort: a review never fails because its open findings could not be read.
    return UNCHECKED;
  }
  const slot = params.botSlot ?? MAIN_BOT_SLOT;
  const open = comments.filter(
    (c) =>
      c.user?.login === params.publisherLogin &&
      parseFingerprintFromComment(c.body) !== null &&
      commentBotSlot(c.body) === slot &&
      openThreadRoots.has(c.id),
  );
  // Over the cap the newest comments (ids grow over time) are kept, so the same files do not
  // always lose out; the block lists them by place for reading.
  const newest = [...open].sort((a, b) => b.id - a.id).slice(0, OPEN_FINDINGS_MAX);
  return { findings: newest.map(toOpenFinding).sort(byPlace), total: open.length, unchecked: false };
}

/**
 * Open findings are read once per client, pull request, publisher and slot: the bots of a
 * consensus panel share slot 1's. The App makes one client per job and the Action one per run,
 * so a cached answer never outlives the review it was read for.
 */
const cache = new WeakMap<GitHubClient, Map<string, Promise<GatheredOpenFindings>>>();

/** The bot's own still-open findings on the pull request. */
export function gatherOpenFindings(client: GitHubClient, params: GatherOpenFindingsParams): Promise<GatheredOpenFindings> {
  let perClient = cache.get(client);
  if (!perClient) {
    perClient = new Map();
    cache.set(client, perClient);
  }
  const key = `${params.owner}/${params.repo}#${params.pull_number}:${params.publisherLogin}:${params.botSlot ?? MAIN_BOT_SLOT}`;
  let read = perClient.get(key);
  if (!read) {
    read = readOpenFindings(client, params);
    perClient.set(key, read);
  }
  return read;
}

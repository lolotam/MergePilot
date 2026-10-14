import type { GitHubClient } from './client.js';
import { fetchAllIssueComments } from './pause.js';

/**
 * `@mergepilot review` / `@mergepilot مراجعة`: asks every active bot to review the whole PR head
 * again, even when nothing changed since its last review. Like pause/resume, the command must
 * stand on its own, so the bot's own notes, which quote it in backticks, never trigger it.
 */
const REVIEW_COMMAND_REGEX = /(?:^|\s)@mergepilot\s+(review|مراجعة)(?=[\s.,!?؟،]|$)/i;

/** The reply language of a `@mergepilot review` comment, or null when the comment is not one. */
export function parseReviewCommand(body: string | null | undefined): { language: 'ar' | 'en' } | null {
  if (!body) return null;
  const word = body.match(REVIEW_COMMAND_REGEX)?.[1]?.toLowerCase();
  if (word === 'review') return { language: 'en' };
  if (word === 'مراجعة') return { language: 'ar' };
  return null;
}

/** Why a `@mergepilot review` request was not run; each gets a short reply on the PR. */
export type ReviewCommandRejection = 'unauthorized' | 'closed' | 'running';

const REJECTION_TEXT: Record<ReviewCommandRejection, { en: string; ar: string }> = {
  unauthorized: {
    en: 'Only people with write access to this repository can ask MergePilot for a review.',
    ar: 'طلب مراجعة من MergePilot متاح بس لأصحاب صلاحية الكتابة على الريبو.',
  },
  closed: {
    en: 'This pull request is closed, so MergePilot will not review it.',
    ar: 'الـ Pull Request ده مقفول، فـ MergePilot مش هيراجعه.',
  },
  running: {
    en: 'A MergePilot review of this commit is already running; its results will appear here.',
    ar: 'فيه مراجعة من MergePilot شغالة دلوقتي على الـ commit ده، ونتيجتها هتظهر هنا.',
  },
};

function replyMarker(deliveryId: string): string {
  return `<!-- mergepilot:review-command-reply delivery=${deliveryId} -->`;
}

/**
 * Replies to a `@mergepilot review` request that was not run, saying why. The reply carries the
 * request's delivery id in a hidden marker and is skipped when the publisher already posted it, so
 * a sequential retry of the same request does not post it again (two attempts running at the same
 * moment could still both post: the check is not atomic).
 */
export async function replyReviewCommandRejected(
  client: GitHubClient,
  params: {
    owner: string;
    repo: string;
    pull_number: number;
    reason: ReviewCommandRejection;
    language: 'ar' | 'en';
    deliveryId: string;
    publisherLogin: string;
  },
): Promise<void> {
  if (!client.createIssueComment) return;
  const marker = replyMarker(params.deliveryId);
  const comments = await fetchAllIssueComments(client, params);
  if (comments.some((c) => c.user?.login === params.publisherLogin && c.body?.includes(marker))) return;
  const text = REJECTION_TEXT[params.reason];
  const body = params.language === 'ar'
    ? `<div dir="rtl">\n\n> ${text.ar}\n\n</div>\n\n${marker}`
    : `> ${text.en}\n\n${marker}`;
  await client.createIssueComment({ owner: params.owner, repo: params.repo, issue_number: params.pull_number, body });
}

function nothingNewMarker(headSha: string): string {
  return `<!-- mergepilot:nothing-new head=${headSha} -->`;
}

export interface NothingNewNoteParams {
  owner: string;
  repo: string;
  pull_number: number;
  headSha: string;
  publisherLogin: string;
  language: 'ar' | 'en';
}

/**
 * Says on the PR, once per head, that no bot reviewed this push because nothing changed since
 * their last review (for example a merge from the base branch). Without it the skip is silent and
 * looks like MergePilot did not run. Returns whether a note was posted.
 */
export async function postNothingNewNoteOnce(client: GitHubClient, params: NothingNewNoteParams): Promise<boolean> {
  if (!client.createIssueComment) return false;
  const marker = nothingNewMarker(params.headSha);
  const comments = await fetchAllIssueComments(client, params);
  if (comments.some((c) => c.user?.login === params.publisherLogin && c.body?.includes(marker))) return false;

  const sha = params.headSha.slice(0, 7);
  const body = params.language === 'ar'
    ? `<div dir="rtl">\n\n> ℹ️ **MergePilot: مفيش تغييرات جديدة للمراجعة في \`${sha}\`**\n>\n> الكود اللي في الـ commit ده اتراجع قبل كده (زي merge من الفرع الأساسي). لمراجعة الـ PR كله من جديد اكتب \`@mergepilot مراجعة\`.\n\n</div>\n\n${marker}`
    : `> ℹ️ **MergePilot: no new changes to review in \`${sha}\`**\n>\n> This push only brings code that was already reviewed (for example a merge from the base branch). To review the whole PR again, comment \`@mergepilot review\`.\n\n${marker}`;
  await client.createIssueComment({ owner: params.owner, repo: params.repo, issue_number: params.pull_number, body });
  return true;
}

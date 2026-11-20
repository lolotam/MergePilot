import type { GitHubClient } from './client.js';
import { shortenDetail } from './fallback-reason.js';
import { fetchAllIssueComments } from './pause.js';
import { neutralize } from './text-safety.js';

function panelFailedMarker(headSha: string, attemptId: string): string {
  return `<!-- mergepilot:panel-failed head=${headSha} attempt=${attemptId} -->`;
}

export interface PanelFailedNoteParams {
  owner: string;
  repo: string;
  pull_number: number;
  headSha: string;
  /** The review job's id: a retry on the same head is a new attempt and gets its own note. */
  attemptId: string;
  publisherLogin: string;
  language: 'ar' | 'en';
  /** A short, already-redacted line from the failing bot; shortened and neutralized again below. */
  reason: string;
}

/**
 * Says on the PR, once per head and review attempt, that no reviewer finished this consensus review and how to retry.
 * Without it a panel whose bots all failed publishes nothing and the PR stays silent. Returns
 * whether a note was posted.
 */
export async function postPanelFailedNoteOnce(client: GitHubClient, params: PanelFailedNoteParams): Promise<boolean> {
  if (!client.createIssueComment) return false;
  const marker = panelFailedMarker(params.headSha, params.attemptId.replace(/[^\w.-]/g, '_'));
  const comments = await fetchAllIssueComments(client, params);
  if (comments.some((c) => c.user?.login === params.publisherLogin && c.body?.includes(marker))) return false;

  const sha = params.headSha.slice(0, 7);
  const isArabic = params.language === 'ar';
  const why = neutralize(shortenDetail(params.reason));
  const body = isArabic
    ? `<div dir="rtl">\n\n> ⚠️ **MergePilot مراجعة \`${sha}\`: مفيش مراجع خلص**\n>\n> البوتات ما قدرتش تكمل المراجعة دي. السبب: ${why}\n>\n> اكتب \`@mergepilot مراجعة\` عشان تتعمل من جديد.\n\n</div>\n\n${marker}`
    : `> ⚠️ **MergePilot review of \`${sha}\`: no reviewer finished**\n>\n> The bots could not complete this review. Reason: ${why}\n>\n> Comment \`@mergepilot review\` to run it again.\n\n${marker}`;
  await client.createIssueComment({ owner: params.owner, repo: params.repo, issue_number: params.pull_number, body });
  return true;
}

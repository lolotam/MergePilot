import type { GitHubClient, GitHubIssueComment } from './client.js';

export type PauseCommand = 'pause' | 'resume';

export interface PauseCommandParams {
  owner: string;
  repo: string;
  pull_number: number;
  command: PauseCommand;
  username: string;
  authorAssociation?: string | undefined;
  publisherLogin: string;
  language?: 'ar' | 'en' | undefined;
}

export type ExecutePauseCommandResult =
  | { success: true; state: 'paused' | 'active' }
  | { success: false; reason: 'unauthorized' | 'label_error' };

export interface CheckPauseParams {
  owner: string;
  repo: string;
  pull_number: number;
  publisherLogin: string;
  labels?: string[] | undefined;
}

export interface PauseNoticeParams {
  owner: string;
  repo: string;
  pull_number: number;
  publisherLogin: string;
  language?: 'ar' | 'en' | undefined;
}

const PAUSE_STATE_REGEX = /<!--\s*mergepilot:state\s+(paused|active)\s*-->/i;
const PAUSE_NOTICE_MARKER = '<!-- mergepilot:pause-notice -->';
export const PAUSE_LABEL = 'mergepilot:paused';
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const COMMAND_REGEX = /(?:^|\s)@mergepilot\s+(pause|resume|إيقاف|استئناف)(?=[\s.,!?؟،]|$)/i;
const COMMENTS_PAGE_SIZE = 100;

/**
 * Parses pause/resume PR comment commands and Arabic aliases:
 * - `@mergepilot pause` / `@mergepilot إيقاف` → 'pause'
 * - `@mergepilot resume` / `@mergepilot استئناف` → 'resume'
 * The command must stand on its own (preceded by whitespace or the start of the comment), so the
 * bot's own replies, which quote the command in backticks, never trigger it again.
 */
export function parsePauseCommand(body: string | null | undefined): PauseCommand | null {
  return parsePauseCommandWithLanguage(body)?.command ?? null;
}

/** Like `parsePauseCommand`, plus the reply language: Arabic when an Arabic alias was used. */
export function parsePauseCommandWithLanguage(
  body: string | null | undefined,
): { command: PauseCommand; language: 'ar' | 'en' } | null {
  if (!body) return null;
  const word = body.match(COMMAND_REGEX)?.[1]?.toLowerCase();
  if (word === 'pause') return { command: 'pause', language: 'en' };
  if (word === 'resume') return { command: 'resume', language: 'en' };
  if (word === 'إيقاف') return { command: 'pause', language: 'ar' };
  if (word === 'استئناف') return { command: 'resume', language: 'ar' };
  return null;
}

/**
 * Verifies that the commenting user has write access to the repository (write, maintain or admin
 * through the collaborator permission API). The repository owner is accepted from the comment's
 * author association; MEMBER / COLLABORATOR are not enough on their own (they can be read-only).
 */
export async function isAuthorizedToControlPause(
  client: GitHubClient,
  params: {
    owner: string;
    repo: string;
    username: string;
    authorAssociation?: string | undefined;
  },
): Promise<boolean> {
  const { owner, repo, username, authorAssociation } = params;
  if (!username) return false;

  if (authorAssociation?.toUpperCase() === 'OWNER') {
    return true;
  }

  if (client.getCollaboratorPermission) {
    try {
      const res = await client.getCollaboratorPermission({ owner, repo, username });
      return WRITE_PERMISSIONS.has(res.permission?.toLowerCase() ?? '');
    } catch {
      // Unknown permission: treated as no write access.
    }
  }

  return false;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === 404
  );
}

async function fetchAllIssueComments(
  client: GitHubClient,
  params: { owner: string; repo: string; pull_number: number },
): Promise<GitHubIssueComment[]> {
  if (!client.listIssueCommentsPage) return [];

  const comments: GitHubIssueComment[] = [];
  let page = 1;

  while (true) {
    const pageComments = await client.listIssueCommentsPage({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pull_number,
      page,
      per_page: COMMENTS_PAGE_SIZE,
    });

    comments.push(...pageComments);
    if (pageComments.length < COMMENTS_PAGE_SIZE) {
      break;
    }
    page++;
  }

  return comments;
}

/**
 * Determines whether automatic reviews on the PR are paused:
 * Checks PR labels for `mergepilot:paused` and comment markers `<!-- mergepilot:state paused|active -->`.
 */
export async function isPrPaused(
  client: GitHubClient,
  params: CheckPauseParams,
): Promise<boolean> {
  const { labels = [] } = params;

  if (labels.includes(PAUSE_LABEL)) {
    return true;
  }

  const comments = await fetchAllIssueComments(client, params);
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment && comment.user?.login === params.publisherLogin && comment.body) {
      const match = comment.body.match(PAUSE_STATE_REGEX);
      if (match && match[1]) {
        return match[1].toLowerCase() === 'paused';
      }
    }
  }

  return false;
}

/**
 * Checks whether the pause notice was already posted during the current pause: a notice posted
 * before the latest pause/resume state comment belongs to an earlier pause and does not count.
 */
export async function hasPauseNoticeBeenPosted(
  client: GitHubClient,
  params: { owner: string; repo: string; pull_number: number; publisherLogin: string },
): Promise<boolean> {
  const comments = await fetchAllIssueComments(client, params);
  let posted = false;
  for (const c of comments) {
    if (c.user?.login !== params.publisherLogin || !c.body) continue;
    if (PAUSE_STATE_REGEX.test(c.body)) posted = false;
    if (c.body.includes(PAUSE_NOTICE_MARKER)) posted = true;
  }
  return posted;
}

/**
 * Posts a one-time notice when an automatic review is skipped due to a paused PR.
 * Skips posting if a notice was already posted.
 */
export async function postPauseNoticeOnce(
  client: GitHubClient,
  params: PauseNoticeParams,
): Promise<boolean> {
  const alreadyPosted = await hasPauseNoticeBeenPosted(client, params);
  if (alreadyPosted) {
    return false;
  }

  if (!client.createIssueComment) {
    return false;
  }

  const isArabic = params.language === 'ar';
  let body: string;

  if (isArabic) {
    body = `<div dir="rtl">\n\n> ⏸️ **تم تخطي مراجعة MergePilot**\n>\n> المراجعات التلقائية متوقفة مؤقتًا لهذا الطلب. اكتب \`@mergepilot استئناف\` للاستئناف.\n\n</div>\n\n${PAUSE_NOTICE_MARKER}`;
  } else {
    body = `> ⏸️ **MergePilot review skipped**\n>\n> Automatic reviews are paused on this PR. Comment \`@mergepilot resume\` to resume.\n\n${PAUSE_NOTICE_MARKER}`;
  }

  await client.createIssueComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pull_number,
    body,
  });

  return true;
}

/**
 * Executes a pause or resume command on a PR:
 * Verifies caller write access, updates labels and state marker comment, and posts confirmation.
 */
export async function executePauseCommand(
  client: GitHubClient,
  params: PauseCommandParams,
): Promise<ExecutePauseCommandResult> {
  const authorized = await isAuthorizedToControlPause(client, {
    owner: params.owner,
    repo: params.repo,
    username: params.username,
    authorAssociation: params.authorAssociation,
  });

  const isArabic = params.language === 'ar';

  if (!authorized) {
    if (client.createIssueComment) {
      const rejectBody = isArabic
        ? `<div dir="rtl">\n\n⚠️ عذرًا @${params.username}، يجب أن تمتلك صلاحية الكتابة (write access) لإيقاف أو استئناف مراجعات MergePilot.\n\n</div>`
        : `⚠️ Sorry @${params.username}, you need write access to pause or resume MergePilot reviews.`;
      await client.createIssueComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.pull_number,
        body: rejectBody,
      });
    }
    return { success: false, reason: 'unauthorized' };
  }

  if (params.command === 'pause') {
    if (client.addLabels) {
      try {
        await client.addLabels({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.pull_number,
          labels: [PAUSE_LABEL],
        });
      } catch {
        // Tolerated if permissions for labels are restricted
      }
    }

    if (client.createIssueComment) {
      const reply = isArabic
        ? `<div dir="rtl">\n\n⏸️ تم إيقاف المراجعات التلقائية مؤقتًا لهذا الطلب. للاستئناف، اكتب \`@mergepilot استئناف\`.\n\n</div>\n\n<!-- mergepilot:state paused -->`
        : `⏸️ Automatic reviews paused on this PR. To resume, comment \`@mergepilot resume\`.\n\n<!-- mergepilot:state paused -->`;
      await client.createIssueComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.pull_number,
        body: reply,
      });
    }

    return { success: true, state: 'paused' };
  }

  // Resume command. The label takes precedence in isPrPaused, so "resumed" is only replied once
  // the label is really gone: a 404 (label absent) is fine, any other error is a failure.
  if (client.removeLabel) {
    try {
      await client.removeLabel({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.pull_number,
        name: PAUSE_LABEL,
      });
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        if (client.createIssueComment) {
          const failBody = isArabic
            ? `<div dir="rtl">\n\n⚠️ ما قدرتش أشيل الوسم \`${PAUSE_LABEL}\`، فالمراجعات لسه متوقفة. راجع صلاحيات MergePilot على الريبو (labels) أو شيل الوسم يدويًا.\n\n</div>`
            : `⚠️ Could not remove the \`${PAUSE_LABEL}\` label, so reviews are still paused. Check MergePilot's permissions on this repository (labels) or remove the label by hand.`;
          await client.createIssueComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.pull_number,
            body: failBody,
          });
        }
        return { success: false, reason: 'label_error' };
      }
    }
  }

  if (client.createIssueComment) {
    const reply = isArabic
      ? `<div dir="rtl">\n\n▶️ تم استئناف المراجعات التلقائية لهذا الطلب.\n\n</div>\n\n<!-- mergepilot:state active -->`
      : `▶️ Automatic reviews resumed on this PR.\n\n<!-- mergepilot:state active -->`;
    await client.createIssueComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pull_number,
      body: reply,
    });
  }

  return { success: true, state: 'active' };
}

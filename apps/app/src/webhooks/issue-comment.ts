import { parsePauseCommandWithLanguage, parseReviewCommand } from '@mergepilot/github';
import { z } from 'zod';
import type { AppStore, CommandJob, ReviewQueue } from '../core/types.js';

/** Result of an `issue_comment` delivery that carried a pause/resume/review command. */
export interface CommandQueuedResult {
  status: 'command_queued';
  job: CommandJob;
}

type ParsedCommand = { command: CommandJob['command']; language: 'ar' | 'en' };

function parseCommand(body: string | null | undefined): ParsedCommand | null {
  const pause = parsePauseCommandWithLanguage(body);
  if (pause) return pause;
  const review = parseReviewCommand(body);
  return review ? { command: 'review', language: review.language } : null;
}

export type IssueCommentResult = CommandQueuedResult | { status: 'ignored'; reason: string };

const IssueCommentPayloadSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: z.object({ full_name: z.string().min(1) }),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    body: z.string().nullable().optional(),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullable().optional(),
  }),
});

/**
 * Routes an `issue_comment` webhook (ADR-0012): only a newly created comment on a pull request
 * whose body is `@mergepilot pause|resume|review` (or an Arabic alias) is queued; everything else is
 * ignored. The handler makes no GitHub call, so the webhook is acknowledged fast; the worker
 * checks the commenter's write access before changing anything.
 */
export async function handleIssueCommentEvent(
  deliveryId: string,
  payload: unknown,
  store: AppStore,
  queue: ReviewQueue,
): Promise<IssueCommentResult> {
  const parsed = IssueCommentPayloadSchema.safeParse(payload);
  if (!parsed.success) return { status: 'ignored', reason: 'invalid_issue_comment_payload' };

  const { action, installation, repository, issue, comment } = parsed.data;
  if (action !== 'created') return { status: 'ignored', reason: 'issue_comment_not_created' };
  if (issue.pull_request === undefined || issue.pull_request === null) {
    return { status: 'ignored', reason: 'not_a_pull_request' };
  }
  const login = comment.user?.login ?? '';
  // Bot comments (MergePilot's own replies included) never run a command.
  if (!login || comment.user?.type === 'Bot' || login.endsWith('[bot]')) {
    return { status: 'ignored', reason: 'bot_comment' };
  }

  const parsedCommand = parseCommand(comment.body);
  if (!parsedCommand) return { status: 'ignored', reason: 'not_a_command' };

  const storedInstallation = await store.getInstallation(installation.id);
  if (!storedInstallation) return { status: 'ignored', reason: 'installation_not_found_or_pending' };
  if (storedInstallation.suspended) return { status: 'ignored', reason: 'installation_suspended' };
  if (!queue.enqueueCommand) return { status: 'ignored', reason: 'command_queue_unavailable' };

  const common = {
    deliveryId,
    installationId: installation.id,
    repoFullName: repository.full_name,
    pullNumber: issue.number,
    commenterLogin: login,
    language: parsedCommand.language,
  };
  const job: CommandJob = parsedCommand.command === 'review'
    ? { ...common, kind: 'review_command', command: 'review' }
    : { ...common, kind: 'pause_command', command: parsedCommand.command };
  await queue.enqueueCommand(job);
  return { status: 'command_queued', job };
}

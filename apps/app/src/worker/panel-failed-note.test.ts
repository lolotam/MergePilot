import type { GitHubClient, GitHubIssueComment } from '@mergepilot/github';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_BOT_SLOT, type ReviewJob, type WorkspaceSettings } from '../core/types.js';
import { notePanelFailed } from './panel-failed-note.js';
import type { PanelContext } from './panel-types.js';
import type { ProcessReviewResult } from './types.js';

const PUBLISHER = 'mergepilot[bot]';
const HEAD = 'sha-panel-head-123456';

function commentsClient(comments: GitHubIssueComment[]): GitHubClient {
  return {
    listPullRequestFilesPage: async () => [],
    getPullRequest: async () => ({ head: { sha: HEAD } }),
    listReviewsPage: async () => [],
    createReview: async () => ({ id: 1 }),
    getFileContent: async () => null,
    compareCommits: async () => null,
    listIssueCommentsPage: async () => comments,
    createIssueComment: async ({ body }) => {
      comments.push({ id: comments.length + 1, body, user: { login: PUBLISHER } });
      return { id: comments.length };
    },
  };
}

function setup(language: 'ar' | 'en' = 'en', panelActive = true) {
  const comments: GitHubIssueComment[] = [];
  const client = commentsClient(comments);
  const info = vi.fn();
  const warn = vi.fn();
  const ctx = {
    client,
    owner: 'o',
    repo: 'r',
    job: { deliveryId: 'del-1', pullNumber: 7, headSha: HEAD } as ReviewJob,
    publisherLogin: PUBLISHER,
    settings: { language } as WorkspaceSettings,
    logger: { info, warn } as unknown as Logger,
    panelActive,
    mode: 'consensus',
  } as PanelContext;
  return { ctx, client, comments, info, warn };
}

const failed = (detail: string): ProcessReviewResult => ({ status: 'failed', detail });

describe('notePanelFailed', () => {
  it('posts once when every bot failed, using the main bot reason', async () => {
    const { ctx, comments, info } = setup();
    const results = new Map<number, ProcessReviewResult>([
      [MAIN_BOT_SLOT, failed('shared 429 from OpenAI')],
      [2, failed('also failed')],
    ]);

    await notePanelFailed(ctx, results);
    await notePanelFailed(ctx, results);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('no reviewer finished');
    expect(comments[0]?.body).toContain('Reason: shared 429 from OpenAI');
    expect(comments[0]?.body).toContain(`<!-- mergepilot:panel-failed head=${HEAD} -->`);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('posts no note when one bot completed', async () => {
    const { ctx, comments } = setup();
    const results = new Map<number, ProcessReviewResult>([
      [MAIN_BOT_SLOT, failed('rate limit')],
      [2, { status: 'completed' }],
    ]);

    await notePanelFailed(ctx, results);

    expect(comments).toHaveLength(0);
  });

  it('posts no note when every bot skipped for budget', async () => {
    const { ctx, comments } = setup();
    const results = new Map<number, ProcessReviewResult>([
      [MAIN_BOT_SLOT, { status: 'skipped', detail: 'monthly budget reached', skippedForBudget: true }],
      [2, { status: 'skipped', detail: 'monthly budget reached', skippedForBudget: true }],
    ]);

    await notePanelFailed(ctx, results);

    expect(comments).toHaveLength(0);
  });

  it('posts no note outside a consensus panel', async () => {
    const { ctx, comments } = setup('en', false);

    await notePanelFailed(ctx, new Map([[MAIN_BOT_SLOT, failed('rate limit')]]));

    expect(comments).toHaveLength(0);
  });

  it('posts no note when no bot ran', async () => {
    const { ctx, comments } = setup();

    await notePanelFailed(ctx, new Map());

    expect(comments).toHaveLength(0);
  });

  it('logs a failed post without throwing or failing the job', async () => {
    const { ctx, client, warn } = setup();
    client.createIssueComment = async () => {
      throw new Error('GitHub 502');
    };

    await expect(notePanelFailed(ctx, new Map([[MAIN_BOT_SLOT, failed('rate limit')]]))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'review.panel_failed_note_failed', jobId: 'del-1', error: 'Error' }),
      'Could not post the panel-failed note',
    );
  });
});

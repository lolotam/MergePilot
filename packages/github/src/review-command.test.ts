import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, GitHubIssueComment } from './client.js';
import { selectIncrementalFiles } from './incremental.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { publishReview } from './publish.js';
import { postNothingNewNoteOnce, replyReviewCommandRejected } from './review-command.js';

const PUBLISHER = 'mergepilot[bot]';
const prFiles: PullRequestFile[] = [
  { path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1, changes: 2 },
];
/** A PR whose head `head-1` this bot already reviewed to completion. */
const reviewedClient = (): GitHubClient => ({
  listPullRequestFilesPage: async () => [],
  getPullRequest: async () => ({ head: { sha: 'head-1' } }),
  listReviewsPage: async () => [{ id: 1, user: { login: PUBLISHER }, body: buildMarker({ headSha: 'head-1', configHash: 'c' }) }],
  createReview: vi.fn(async () => ({ id: 2 })),
  getFileContent: async () => null,
  compareCommits: async () => null,
});

describe('@mergepilot review forces a full review of an already reviewed head', () => {
  it('selects the whole PR instead of nothing new', async () => {
    const options = { owner: 'o', repo: 'r', pull_number: 1, headSha: 'head-1', publisherLogin: PUBLISHER, prFiles, configHash: 'c' };

    expect(await selectIncrementalFiles(reviewedClient(), options)).toMatchObject({ mode: 'incremental', files: [] });
    expect(await selectIncrementalFiles(reviewedClient(), { ...options, force: true }))
      .toEqual({ mode: 'full', files: prFiles, reason: 'review requested' });
  });

  it('publishes instead of skipping the head as already reviewed', async () => {
    const params = {
      owner: 'o', repo: 'r', pull_number: 1, expectedHeadSha: 'head-1', summaryMarkdown: 'Again.', inline: [],
      configHash: 'c', language: 'en' as const, suggestionsAsCode: false, publisherLogin: PUBLISHER, alreadyDeduplicated: true,
    };

    expect((await publishReview(reviewedClient(), params)).status).toBe('skipped-duplicate');
    expect((await publishReview(reviewedClient(), { ...params, force: true })).status).toBe('published');
  });
});

describe('postNothingNewNoteOnce', () => {
  const commentsClient = (comments: GitHubIssueComment[]): GitHubClient => ({
    ...reviewedClient(),
    listIssueCommentsPage: async () => comments,
    createIssueComment: async ({ body }) => {
      comments.push({ id: comments.length + 1, body, user: { login: PUBLISHER } });
      return { id: comments.length };
    },
  });
  const note = { owner: 'o', repo: 'r', pull_number: 1, publisherLogin: PUBLISHER };

  it('posts once per head: a later head gets its own note', async () => {
    const comments: GitHubIssueComment[] = [];
    const client = commentsClient(comments);

    expect(await postNothingNewNoteOnce(client, { ...note, headSha: 'head-1', language: 'en' })).toBe(true);
    expect(await postNothingNewNoteOnce(client, { ...note, headSha: 'head-1', language: 'en' })).toBe(false);
    expect(await postNothingNewNoteOnce(client, { ...note, headSha: 'head-2', language: 'en' })).toBe(true);
    expect(comments).toHaveLength(2);
  });

  it('ignores a look-alike marker pasted by someone else', async () => {
    const comments: GitHubIssueComment[] = [
      { id: 1, body: '<!-- mergepilot:nothing-new head=head-1 -->', user: { login: 'someone' } },
    ];

    expect(await postNothingNewNoteOnce(commentsClient(comments), { ...note, headSha: 'head-1', language: 'en' })).toBe(true);
  });

  it('writes the Arabic note with the Arabic command', async () => {
    const comments: GitHubIssueComment[] = [];

    await postNothingNewNoteOnce(commentsClient(comments), { ...note, headSha: 'head-1', language: 'ar' });

    expect(comments[0]?.body).toContain('<div dir="rtl">');
    expect(comments[0]?.body).toContain('`@mergepilot مراجعة`');
  });

describe('replyReviewCommandRejected', () => {
  it('posts the refusal once per request, so a retried job does not repeat it', async () => {
    const comments: GitHubIssueComment[] = [];
    const client: GitHubClient = {
      ...reviewedClient(),
      listIssueCommentsPage: async () => comments,
      createIssueComment: async ({ body }) => {
        comments.push({ id: comments.length + 1, body, user: { login: PUBLISHER } });
        return { id: comments.length };
      },
    };
    const reply = { owner: 'o', repo: 'r', pull_number: 1, reason: 'closed' as const, language: 'en' as const, publisherLogin: PUBLISHER };

    await replyReviewCommandRejected(client, { ...reply, deliveryId: 'd-1' });
    await replyReviewCommandRejected(client, { ...reply, deliveryId: 'd-1' });
    await replyReviewCommandRejected(client, { ...reply, deliveryId: 'd-2' });

    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toContain('<!-- mergepilot:review-command-reply delivery=d-1 -->');
  });
});
});

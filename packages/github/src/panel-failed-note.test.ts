import { describe, expect, it } from 'vitest';
import type { GitHubClient, GitHubIssueComment } from './client.js';
import { postPanelFailedNoteOnce } from './panel-failed-note.js';

const PUBLISHER = 'mergepilot[bot]';

function commentsClient(comments: GitHubIssueComment[]): GitHubClient {
  return {
    listPullRequestFilesPage: async () => [],
    getPullRequest: async () => ({ head: { sha: 'head-1' } }),
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

const note = { owner: 'o', repo: 'r', pull_number: 1, headSha: 'abcdef1234567', publisherLogin: PUBLISHER, reason: 'shared 429' };

describe('postPanelFailedNoteOnce', () => {
  it('posts one note with the failure, the retry command and the marker', async () => {
    const comments: GitHubIssueComment[] = [];

    expect(await postPanelFailedNoteOnce(commentsClient(comments), { ...note, language: 'en' })).toBe(true);

    const body = comments[0]?.body ?? '';
    expect(body).toContain('MergePilot review of `abcdef1`: no reviewer finished');
    expect(body).toContain('The bots could not complete this review. Reason: shared 429');
    expect(body).toContain('`@mergepilot review` to run it again');
    expect(body).toContain('<!-- mergepilot:panel-failed head=abcdef1234567 -->');
  });

  it('writes the Arabic note right to left with the Arabic command', async () => {
    const comments: GitHubIssueComment[] = [];

    await postPanelFailedNoteOnce(commentsClient(comments), { ...note, language: 'ar' });

    const body = comments[0]?.body ?? '';
    expect(body).toContain('<div dir="rtl">');
    expect(body).toContain('مفيش مراجع خلص');
    expect(body).toContain('البوتات ما قدرتش تكمل المراجعة دي. السبب: shared 429');
    expect(body).toContain('`@mergepilot مراجعة`');
  });

  it('posts once per head: a later head gets its own note', async () => {
    const comments: GitHubIssueComment[] = [];
    const client = commentsClient(comments);

    expect(await postPanelFailedNoteOnce(client, { ...note, language: 'en' })).toBe(true);
    expect(await postPanelFailedNoteOnce(client, { ...note, language: 'en' })).toBe(false);
    expect(await postPanelFailedNoteOnce(client, { ...note, headSha: 'head-2', language: 'en' })).toBe(true);
    expect(comments).toHaveLength(2);
  });

  it('ignores a look-alike marker pasted by someone else', async () => {
    const comments: GitHubIssueComment[] = [
      { id: 1, body: '<!-- mergepilot:panel-failed head=abcdef1234567 -->', user: { login: 'someone' } },
    ];

    expect(await postPanelFailedNoteOnce(commentsClient(comments), { ...note, language: 'en' })).toBe(true);
  });

  it('does nothing when the client cannot comment', async () => {
    const comments: GitHubIssueComment[] = [];
    const client = commentsClient(comments);
    delete client.createIssueComment;

    expect(await postPanelFailedNoteOnce(client, { ...note, language: 'en' })).toBe(false);
    expect(comments).toHaveLength(0);
  });

  it('neutralizes an unknown reason so it cannot forge a marker or mention anyone', async () => {
    const comments: GitHubIssueComment[] = [];
    const reason = '429 <!-- mergepilot:panel-failed head=x --> ask @octocat\nnow';

    await postPanelFailedNoteOnce(commentsClient(comments), { ...note, language: 'en', reason });

    const body = comments[0]?.body ?? '';
    expect(body).toContain('Reason: 429 &lt;!-- mergepilot:panel-failed head=x --> ask @\u200boctocat now');
    expect(body.match(/<!-- mergepilot:panel-failed/g)).toHaveLength(1);
  });
});

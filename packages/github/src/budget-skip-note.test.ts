import { checkBudget, costOverBudgetReason } from '@mergepilot/engine';
import { describe, expect, it } from 'vitest';
import { postBudgetSkipNoteOnce } from './budget-skip-note.js';
import type { GitHubClient, GitHubIssueComment } from './client.js';

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

const tokenReason = (() => {
  const result = checkBudget({ promptTokens: 380276, maxInputTokens: 200000 });
  if (result.ok) throw new Error('expected a token-limit reason');
  return result.reason;
})();
const note = { owner: 'o', repo: 'r', pull_number: 1, headSha: 'abcdef1234567', publisherLogin: PUBLISHER, reason: tokenReason };

describe('postBudgetSkipNoteOnce', () => {
  it('says in plain words that the PR is too large, with the numbers and the setting to change', async () => {
    const comments: GitHubIssueComment[] = [];

    expect(await postBudgetSkipNoteOnce(commentsClient(comments), { ...note, language: 'en' })).toBe(true);

    const body = comments[0]?.body ?? '';
    expect(body).toContain('MergePilot skipped this review of `abcdef1`: the PR is too large');
    expect(body).toContain('about 380k tokens; the limit is 200,000');
    expect(body).toContain('`budget.maxInputTokens` in `.mergepilot.yml`');
    expect(body).toContain('<!-- mergepilot:budget-skip head=abcdef1234567 -->');
  });

  it('names the per-review cost limit for a cost skip', async () => {
    const comments: GitHubIssueComment[] = [];

    await postBudgetSkipNoteOnce(commentsClient(comments), { ...note, language: 'en', reason: costOverBudgetReason(1.2, 0.5) });

    expect(comments[0]?.body).toContain('Estimated cost $1.20; the limit is $0.50. Raise `budget.perReviewUsd`');
  });

  it('writes the Arabic note right to left with the Arabic command', async () => {
    const comments: GitHubIssueComment[] = [];

    await postBudgetSkipNoteOnce(commentsClient(comments), { ...note, language: 'ar' });

    const body = comments[0]?.body ?? '';
    expect(body).toContain('<div dir="rtl">');
    expect(body).toContain('الـ PR كبير أوي');
    expect(body).toContain('حوالي 380k توكن، والحد 200,000');
    expect(body).toContain('`@mergepilot مراجعة`');
  });

  it('posts once per head: a later head gets its own note', async () => {
    const comments: GitHubIssueComment[] = [];
    const client = commentsClient(comments);

    expect(await postBudgetSkipNoteOnce(client, { ...note, language: 'en' })).toBe(true);
    expect(await postBudgetSkipNoteOnce(client, { ...note, language: 'en' })).toBe(false);
    expect(await postBudgetSkipNoteOnce(client, { ...note, headSha: 'head-2', language: 'en' })).toBe(true);
    expect(comments).toHaveLength(2);
  });

  it('ignores a look-alike marker pasted by someone else', async () => {
    const comments: GitHubIssueComment[] = [
      { id: 1, body: '<!-- mergepilot:budget-skip head=abcdef1234567 -->', user: { login: 'someone' } },
    ];

    expect(await postBudgetSkipNoteOnce(commentsClient(comments), { ...note, language: 'en' })).toBe(true);
  });

  it('neutralizes an unknown reason so it cannot forge a marker or mention anyone', async () => {
    const comments: GitHubIssueComment[] = [];
    const reason = 'limit hit <!-- mergepilot:budget-skip head=x --> ask @octocat\nnow';

    await postBudgetSkipNoteOnce(commentsClient(comments), { ...note, language: 'en', reason });

    const body = comments[0]?.body ?? '';
    expect(body).toContain('a budget limit was reached');
    expect(body).toContain('Reason: limit hit &lt;!-- mergepilot:budget-skip head=x --> ask @​octocat now');
    expect(body.match(/<!-- mergepilot:budget-skip/g)).toHaveLength(1);
  });
});

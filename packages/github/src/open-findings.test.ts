import { describe, expect, it } from 'vitest';
import { OPEN_FINDINGS_MAX } from '@mergepilot/engine';
import type { GitHubClient, GitHubReviewComment, GitHubReviewThread } from './client.js';
import { gatherOpenFindings } from './open-findings.js';

// ADR-0030: a follow-up review re-checks only the bot's own findings whose threads are open,
// found by the `mp:f` marker on the publisher's comments, and shows none it could not verify.

const PUBLISHER = 'mergepilot[bot]';

function comment(id: number, overrides: Partial<GitHubReviewComment> = {}): GitHubReviewComment {
  return {
    id,
    path: 'src/a.ts',
    line: id,
    user: { login: PUBLISHER },
    body: [
      `### Finding ${id}`,
      '**Severity:** `HIGH`',
      `Body of finding ${id}.`,
      '**Evidence:**\n```\nconst x = 1;\n```',
      `<!-- mp:f=${String(id).padStart(16, '0')} -->`,
    ].join('\n\n'),
    ...overrides,
  };
}

function client(comments: GitHubReviewComment[], threads?: GitHubReviewThread[] | Error): GitHubClient {
  return {
    listPullRequestFilesPage: async () => [],
    getPullRequest: async () => ({ head: { sha: 'h' } }),
    listReviewsPage: async () => [],
    createReview: async () => ({ id: 1 }),
    getFileContent: async () => null,
    compareCommits: async () => null,
    listReviewCommentsPage: async ({ page }) => (page === 1 ? comments : []),
    ...(threads === undefined
      ? {}
      : {
          listReviewThreads: async () => {
            if (threads instanceof Error) throw threads;
            return threads;
          },
        }),
  };
}

const open = (id: number): GitHubReviewThread => ({ isResolved: false, firstCommentId: id });
const params = { owner: 'o', repo: 'r', pull_number: 3, publisherLogin: PUBLISHER };

describe('gatherOpenFindings', () => {
  it("keeps only this bot's own marked findings whose threads are still open", async () => {
    const comments = [
      comment(1),
      comment(2), // resolved thread
      comment(3, { user: { login: 'octocat' } }), // a human pasted the marker
      comment(4, { user: { login: 'other-app[bot]' } }), // another bot
      comment(5, { body: '### Not a finding\n\nplain reply' }), // no finding marker
      comment(6, { body: `${comment(6).body}\n\n<!-- mergepilot:bot=2 -->` }), // panel bot 2
      comment(7, { line: null }), // open, but its line left the diff
    ];
    const threads = [open(1), { isResolved: true, firstCommentId: 2 }, open(3), open(4), open(5), open(6), open(7)];

    const result = await gatherOpenFindings(client(comments, threads), params);

    expect(result.unchecked).toBe(false);
    expect(result.findings).toEqual([
      { id: '1', path: 'src/a.ts', line: 1, title: 'Finding 1', body: '**Severity:** `HIGH`\n\nBody of finding 1.' },
      { id: '7', path: 'src/a.ts', title: 'Finding 7', body: '**Severity:** `HIGH`\n\nBody of finding 7.' },
    ]);
  });

  it("reads a panel bot's own slot only", async () => {
    const tagged = comment(6, { body: `${comment(6).body}\n\n<!-- mergepilot:bot=2 -->` });
    const result = await gatherOpenFindings(client([comment(1), tagged], [open(1), open(6)]), { ...params, botSlot: 2 });
    expect(result.findings.map((f) => f.id)).toEqual(['6']);
  });

  it(`shows the newest ${OPEN_FINDINGS_MAX} over the cap, by place, and counts them all`, async () => {
    // The 4 oldest sit first by path: a cut by path order would keep them.
    const comments = Array.from({ length: OPEN_FINDINGS_MAX + 4 }, (_, i) =>
      comment(i + 1, { path: i < 4 ? 'a/oldest.ts' : 'z/newer.ts' }),
    );
    const result = await gatherOpenFindings(client(comments, comments.map((c) => open(c.id))), params);

    expect(result.total).toBe(OPEN_FINDINGS_MAX + 4);
    expect(result.findings).toHaveLength(OPEN_FINDINGS_MAX);
    expect(result.findings.some((f) => f.path === 'a/oldest.ts')).toBe(false);
    expect(result.findings.map((f) => f.line)).toEqual([...result.findings.map((f) => f.line!)].sort((a, b) => a - b));
  });

  it('shows none, and says so, when the thread status cannot be read', async () => {
    const none = { findings: [], total: 0, unchecked: true };
    expect(await gatherOpenFindings(client([comment(1)]), params)).toEqual(none);
    expect(await gatherOpenFindings(client([comment(1)], new Error('graphql 502')), params)).toEqual(none);
  });
});

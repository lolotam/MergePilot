import { describe, expect, it } from 'vitest';
import type { MergePilotConfig, ReviewModel, ReviewModelRequest } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient, GitHubReviewComment } from './client.js';
import { reviewPullRequest } from './review-pull-request.js';

// ADR-0030 on the Action path: an incremental run reviews the new changes with the rest of the PR
// and the bot's open findings as context, and says so in the summary; a first review does not.

const PUBLISHER = 'github-actions[bot]';
const lastHead = 'a1a1a1a1a1a1a1a1';
const headSha = 'b2b2b2b2b2b2b2b2';

const routePatch = "@@ -1,2 +1,3 @@\n import { db } from '../db/client.js';\n const a = 1;\n+const b = db.get();";
const clientPatch = '@@ -1,1 +1,2 @@\n export const db = open();\n+db.cache = new Map();';
const notesPatch = '@@ -1,1 +1,2 @@\n # Notes\n+more';

function finding(id: number, title: string): GitHubReviewComment {
  return {
    id,
    path: 'src/db/client.ts',
    line: 2,
    user: { login: PUBLISHER },
    body: `### ${title}\n\n**Severity:** \`HIGH\`\n\nThe cache is never cleared.\n\n<!-- mp:f=${String(id).padStart(16, 'f')} -->`,
  };
}

function setup(previousReview: boolean): { client: GitHubClient; created: CreateReviewParams[]; threadReads: number[] } {
  const created: CreateReviewParams[] = [];
  const threadReads: number[] = [];
  const client: GitHubClient = {
    listPullRequestFilesPage: async ({ page }) =>
      page > 1
        ? []
        : [
            { filename: 'src/api/route.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: routePatch },
            { filename: 'src/db/client.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: clientPatch },
            { filename: 'docs/notes.md', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: notesPatch },
          ],
    getPullRequest: async () => ({ head: { sha: headSha } }),
    listReviewsPage: async () =>
      previousReview ? [{ id: 1, user: { login: PUBLISHER }, body: `Done.\n<!-- mergepilot:review head=${lastHead} config=cfg -->` }] : [],
    createReview: async (params) => {
      created.push(params);
      return { id: 2 };
    },
    compareCommits: async ({ base }) =>
      base === lastHead
        ? {
            status: 'ahead',
            totalCommits: 1,
            files: [{ filename: 'src/api/route.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: routePatch }],
          }
        : null,
    getFileContent: async () => null,
    listReviewCommentsPage: async ({ page }) => (page === 1 ? [finding(41, 'Cache grows forever'), finding(42, 'Resolved one')] : []),
    listReviewThreads: async ({ pull_number }) => {
      threadReads.push(pull_number);
      return [
        { isResolved: false, firstCommentId: 41 },
        { isResolved: true, firstCommentId: 42 },
      ];
    },
  };
  return { client, created, threadReads };
}

const config = {
  provider: 'anthropic',
  model: 'claude-x',
  language: 'en',
  review: { maxFindings: 5, minSeverity: 'medium', exclude: [], rulesFiles: [], pathInstructions: [], verify: false },
  budget: { perReviewUsd: 1, maxInputTokens: 200_000 },
} as unknown as MergePilotConfig;

async function review(previousReview: boolean): Promise<{ request: ReviewModelRequest; summary: string; threadReads: number[] }> {
  const { client, created, threadReads } = setup(previousReview);
  const requests: ReviewModelRequest[] = [];
  const model: ReviewModel = {
    label: 'anthropic:claude-x',
    generate: async (req) => {
      requests.push(req);
      return { text: JSON.stringify({ summary: 'Fine.', findings: [] }), finishReason: 'stop' };
    },
  };
  const result = await reviewPullRequest({
    client, owner: 'o', repo: 'r', pullNumber: 4, headSha, baseSha: 'base', prTitle: 'T', prBody: '',
    config, configHash: 'cfg', rulesFiles: [], model, publisherLogin: PUBLISHER,
  });
  expect(result.outcome).toBe('completed');
  return { request: requests[0]!, summary: created[0]?.body ?? '', threadReads };
}

describe('reviewPullRequest — follow-up review (ADR-0030)', () => {
  it('reviews the new changes with the rest of the PR and the open findings as context', async () => {
    const { request, summary } = await review(true);

    expect(request.system).toContain('this is a follow-up review of the changes pushed since a1a1a1a');
    expect(request.user).toContain('<<<UNTRUSTED:PATCH:src/api/route.ts>>>');
    expect(request.user).toContain('<<<UNTRUSTED:PR_CONTEXT:src/db/client.ts>>>\nReason: changed earlier in this pull request; imported by src/api/route.ts');
    expect(request.user).toContain('<<<UNTRUSTED:PR_CONTEXT:docs/notes.md>>>');
    expect(request.user).not.toContain('PATCH:src/db/client.ts');
    expect(request.user).toContain('- src/db/client.ts:2 — Cache grows forever: **Severity:** `HIGH` The cache is never cleared.');
    expect(request.user).not.toContain('Resolved one');
    expect(summary).toContain('Rest of the pull request: 2 other changed files sent as context.');
    expect(summary).toContain('Open findings re-checked: 1.');
  });

  it('keeps a first review a whole-PR review: no PR context, no open findings read', async () => {
    const { request, summary, threadReads } = await review(false);

    expect(request.system).toContain('the diff of every changed file of this pull request');
    expect(request.user).toContain('<<<UNTRUSTED:PATCH:src/db/client.ts>>>');
    expect(request.user).not.toContain('PR_CONTEXT');
    expect(request.user).not.toContain('OPEN_FINDINGS');
    expect(threadReads).toEqual([]);
    expect(summary).not.toContain('Rest of the pull request');
  });
});

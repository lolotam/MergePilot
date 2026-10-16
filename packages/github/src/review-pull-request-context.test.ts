import { describe, expect, it } from 'vitest';
import type { MergePilotConfig, ReviewModel, ReviewModelRequest } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient } from './client.js';
import { reviewPullRequest } from './review-pull-request.js';

// ADR-0029 on the Action path: repository context read at the head reaches the review prompt,
// and the published summary says how many context files were sent.

const baseSha = 'base-sha';
const headSha = 'head-sha';

describe('reviewPullRequest — repository context (ADR-0029)', () => {
  it('passes the head context into the review and discloses it in the summary', async () => {
    const created: CreateReviewParams[] = [];
    const client: GitHubClient = {
      listPullRequestFilesPage: async () => [
        { filename: 'apps/api/route.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n old\n+new line' },
      ],
      getPullRequest: async () => ({ head: { sha: headSha } }),
      listReviewsPage: async () => [],
      createReview: async (params) => {
        created.push(params);
        return { id: 1 };
      },
      compareCommits: async () => null,
      getFileContent: async ({ path, ref }) => {
        if (ref !== headSha) return null;
        if (path === 'apps/api/route.ts') return "import { db } from './db.js';\nold\nnew line";
        if (path === 'apps/api/db.ts') return 'export const db = connect();';
        return null;
      },
    };
    const requests: ReviewModelRequest[] = [];
    const model: ReviewModel = {
      label: 'anthropic:claude-x',
      generate: async (req) => {
        requests.push(req);
        return { text: JSON.stringify({ summary: 'Fine.', findings: [] }), finishReason: 'stop' };
      },
    };
    const config = {
      provider: 'anthropic',
      model: 'claude-x',
      language: 'en',
      review: { maxFindings: 5, minSeverity: 'medium', exclude: [], rulesFiles: [], pathInstructions: [], verify: false },
      budget: { perReviewUsd: 1, maxInputTokens: 200_000 },
    } as unknown as MergePilotConfig;

    const result = await reviewPullRequest({
      client, owner: 'o', repo: 'r', pullNumber: 1, headSha, baseSha, prTitle: 'T', prBody: '',
      config, configHash: 'cfg', rulesFiles: [], model, publisherLogin: 'mergepilot[bot]',
    });

    expect(result.outcome).toBe('completed');
    const prompt = requests[0]?.user ?? '';
    expect(prompt).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:apps/api/route.ts>>>');
    expect(prompt).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:apps/api/db.ts>>>');
    expect(prompt).toContain('Reason: imported by apps/api/route.ts');
    expect(created[0]?.body ?? '').toContain('Repository context: 2 files sent.');
  });
});

import { describe, expect, it } from 'vitest';
import type { MergePilotConfig, ReviewModel, ReviewModelRequest } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient } from '@mergepilot/github';
import { executeReview } from './execute-review.js';

// ADR-0029 on the App path: repository context read at the head reaches the bot's review prompt,
// and the published summary says how many context files were sent.

const baseSha = 'sha-base';
const headSha = 'sha-head';

const config: MergePilotConfig = {
  provider: 'anthropic',
  model: 'claude-x',
  language: 'en',
  review: { maxFindings: 5, minSeverity: 'medium', rulesFiles: [], exclude: [], pathInstructions: [], verify: false },
  budget: { perReviewUsd: 10, maxInputTokens: 100_000 },
} as unknown as MergePilotConfig;

describe('executeReview — repository context (ADR-0029)', () => {
  it('passes the head context into the review and discloses it in the summary', async () => {
    const created: CreateReviewParams[] = [];
    const client = {
      listPullRequestFilesPage: async () => [
        { filename: 'svc/api/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n old\n+new code' },
      ],
      getPullRequest: async () => ({ head: { sha: headSha } }),
      listReviewsPage: async () => [],
      listReviewCommentsPage: async () => [],
      listIssueCommentsPage: async () => [],
      createReview: async (params: CreateReviewParams) => {
        created.push(params);
        return { id: 1 };
      },
      compareCommits: async () => null,
      getFileContent: async ({ path, ref }: { path: string; ref: string }) => {
        if (ref !== headSha) return null;
        if (path === 'svc/api/main.ts') return "import { limit } from '../rate/limit.js';\nold\nnew code";
        if (path === 'svc/rate/limit.ts') return 'export function limit() {}';
        if (path === 'svc/api/main.test.ts') return 'it("limits", () => {});';
        return null;
      },
    } as unknown as GitHubClient;
    const requests: ReviewModelRequest[] = [];
    const model: ReviewModel = {
      label: 'anthropic:claude-x',
      outputTokensFor: (n: number) => n,
      generate: async (req) => {
        requests.push(req);
        return { text: JSON.stringify({ summary: 'Fine.', findings: [] }), finishReason: 'stop' };
      },
    };

    const result = await executeReview({
      client, owner: 'acme', repo: 'repo', pullNumber: 7, headSha, baseSha, prTitle: 'Feature', prBody: '',
      config, configHash: 'cfg', rulesFiles: [], model, publisherLogin: 'mergepilot[bot]',
    });

    expect(result.outcome).toBe('completed');
    const prompt = requests[0]?.user ?? '';
    expect(prompt).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:svc/rate/limit.ts>>>');
    expect(prompt).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:svc/api/main.test.ts>>>');
    expect(prompt).toContain('Reason: test of svc/api/main.ts');
    expect(created[0]?.body ?? '').toContain('Repository context: 3 files sent.');
  });
});

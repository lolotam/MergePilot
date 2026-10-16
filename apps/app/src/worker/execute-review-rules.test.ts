import { describe, expect, it } from 'vitest';
import type { MergePilotConfig, ReviewModel, ReviewModelRequest } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient } from '@mergepilot/github';
import { executeReview } from './execute-review.js';

// ADR-0028 on the App path: nested owner rules come from the base commit, and what verification
// rejected is listed in the published summary.

const baseSha = 'sha-base';
const headSha = 'sha-head';

const config: MergePilotConfig = {
  provider: 'anthropic',
  model: 'claude-x',
  language: 'en',
  review: { maxFindings: 5, minSeverity: 'medium', rulesFiles: [], exclude: [], pathInstructions: [], verify: true },
  budget: { perReviewUsd: 10, maxInputTokens: 100_000 },
} as unknown as MergePilotConfig;

const finding = (title: string) => ({
  path: 'svc/api/main.ts',
  line: 2,
  side: 'RIGHT',
  severity: 'high',
  category: 'correctness',
  title,
  body: 'b',
  evidence: 'new code',
  confidence: 0.9,
});

function setup() {
  const reads: Array<{ path: string; ref: string }> = [];
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
      reads.push({ path, ref });
      if (path === 'svc/AGENTS.md') return ref === baseSha ? 'Every endpoint needs a rate limit.' : 'head copy';
      return null;
    },
  } as unknown as GitHubClient;

  const requests: ReviewModelRequest[] = [];
  const answers = [
    JSON.stringify({ summary: 'Two issues.', findings: [finding('Real bug'), finding('Wrong guess')] }),
    JSON.stringify({ verdicts: [{ id: 'f2', verdict: 'rejected', reason: 'contradicted' }] }),
  ];
  const model: ReviewModel = {
    label: 'anthropic:claude-x',
    outputTokensFor: (n: number) => n,
    generate: async (req) => {
      requests.push(req);
      return { text: answers.shift() ?? '', finishReason: 'stop' };
    },
  };
  return { client, model, reads, created, requests };
}

describe('executeReview — nested rules and verification disclosure (ADR-0028)', () => {
  it('sends the nearest nested AGENTS.md from the base commit and lists what verification rejected', async () => {
    const env = setup();
    const result = await executeReview({
      client: env.client,
      owner: 'acme',
      repo: 'repo',
      pullNumber: 7,
      headSha,
      baseSha,
      prTitle: 'Feature',
      prBody: '',
      config,
      configHash: 'cfg',
      rulesFiles: [],
      model: env.model,
      publisherLogin: 'mergepilot[bot]',
    });

    expect(result.outcome).toBe('completed');
    // Owner rules come from the base; only repository context (ADR-0029) is read at the head.
    expect(env.reads.filter((r) => /(AGENTS|CLAUDE)\.md$/.test(r.path)).every((r) => r.ref === baseSha)).toBe(true);
    const reviewPrompt = env.requests[0]?.user ?? '';
    expect(reviewPrompt).toContain('<<<REVIEW_CRITERIA:RULES_FILE:svc/AGENTS.md>>>');
    expect(reviewPrompt).toContain('Every endpoint needs a rate limit.');
    expect(reviewPrompt).not.toContain('head copy');
    const body = env.created[0]?.body ?? '';
    expect(body).toContain('<summary>Rejected by verification (1)</summary>');
    expect(body).toContain('- Wrong guess · `svc/api/main.ts:2`');
  });
});

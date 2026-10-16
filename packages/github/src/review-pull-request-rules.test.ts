import { describe, expect, it } from 'vitest';
import type { MergePilotConfig, ReviewModel, ReviewModelRequest } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient } from './client.js';
import { reviewPullRequest } from './review-pull-request.js';

// ADR-0028 on the Action path: nested owner rules come from the base commit, capped by
// review.maxRulesTokens with the rest named in the summary, and verification rejections are listed.

const baseSha = 'base-sha';
const headSha = 'head-sha';

function setup(maxRulesTokens: number) {
  const reads: Array<{ path: string; ref: string }> = [];
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
      reads.push({ path, ref });
      if (ref !== baseSha) return 'HEAD';
      if (path === 'apps/AGENTS.md') return 'Apps rule: validate input.';
      if (path === 'apps/api/CLAUDE.md') return 'API rule: '.padEnd(400, 'x');
      return null;
    },
  };
  const requests: ReviewModelRequest[] = [];
  const answers = [
    JSON.stringify({
      summary: 'One issue.',
      findings: [{ path: 'apps/api/route.ts', line: 2, side: 'RIGHT', title: 'Unproven race', body: 'b', severity: 'medium', category: 'correctness', evidence: 'new line', confidence: 0.8 }],
    }),
    JSON.stringify({ verdicts: [{ id: 'f1', verdict: 'rejected', reason: 'not in the code' }] }),
  ];
  const model: ReviewModel = {
    label: 'anthropic:claude-x',
    generate: async (req) => {
      requests.push(req);
      return { text: answers.shift() ?? '', finishReason: 'stop' };
    },
  };
  const config = {
    provider: 'anthropic',
    model: 'claude-x',
    language: 'en',
    review: { maxFindings: 5, minSeverity: 'medium', exclude: [], rulesFiles: [], pathInstructions: [], verify: true, maxRulesTokens },
    budget: { perReviewUsd: 1, maxInputTokens: 200_000 },
    audit: { enabled: false, output: 'summary', maxFiles: 200, include: ['**/*'], exclude: [] },
  } as unknown as MergePilotConfig;
  const run = () =>
    reviewPullRequest({
      client, owner: 'o', repo: 'r', pullNumber: 1, headSha, baseSha, prTitle: 'T', prBody: '',
      config, configHash: 'cfg', rulesFiles: [], model, publisherLogin: 'mergepilot[bot]',
    });
  return { run, reads, created, requests };
}

describe('reviewPullRequest — nested rules and verification disclosure (ADR-0028)', () => {
  it('sends nested rules read from the base commit and lists verification rejections', async () => {
    const env = setup(12_000);
    const result = await env.run();
    expect(result.outcome).toBe('completed');
    expect(env.reads.every((r) => r.ref === baseSha)).toBe(true);
    const prompt = env.requests[0]?.user ?? '';
    expect(prompt).toContain('<<<REVIEW_CRITERIA:RULES_FILE:apps/AGENTS.md>>>');
    expect(prompt).toContain('<<<REVIEW_CRITERIA:RULES_FILE:apps/api/CLAUDE.md>>>');
    expect(prompt).not.toContain('HEAD');
    const body = env.created[0]?.body ?? '';
    expect(body).toContain('<summary>Rejected by verification (1)</summary>');
    expect(body).not.toContain('Rules files not sent');
  });

  it('drops the nested rules over review.maxRulesTokens and names them, without marking the review incomplete', async () => {
    const env = setup(50);
    await env.run();
    const prompt = env.requests[0]?.user ?? '';
    expect(prompt).toContain('Apps rule: validate input.');
    expect(prompt).not.toContain('RULES_FILE:apps/api/CLAUDE.md');
    const body = env.created[0]?.body ?? '';
    expect(body).toContain('Rules files not sent with the review');
    expect(body).toContain('`apps/api/CLAUDE.md`');
    expect(body).not.toContain('Incomplete review');
    expect(body).not.toContain('status=partial');
  });
});

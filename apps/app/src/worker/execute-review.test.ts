import { describe, expect, it, vi } from 'vitest';
import type { MergePilotConfig, ReviewModel } from '@mergepilot/engine';
import { computeFindingFingerprint } from '@mergepilot/github';
import type {
  CreateReviewParams,
  GitHubClient,
  GitHubIssueComment,
  GitHubPullRequestFile,
  GitHubReview,
  GitHubReviewComment,
} from '@mergepilot/github';
import { executeReview } from './execute-review.js';

describe('executeReview — incremental review and deduplication', () => {
  const headSha = 'sha-head-new-111';
  const baseSha = 'sha-base-000';
  const prevSha = 'sha-head-prev-000';
  const configHash = 'cfghash12345';

  const config: MergePilotConfig = {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    language: 'en',
    review: {
      maxFindings: 5,
      minSeverity: 'medium',
      rulesFiles: [],
      exclude: [],
      pathInstructions: [],
      instructions: [],
    },
    budget: {
      perReviewUsd: 10.0,
      maxInputTokens: 100_000,
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
      },
    },
  };

  // A finding as the model returns it, on the added line 5 of the PR patch.
  const sampleFinding = {
    path: 'src/main.ts',
    line: 5,
    side: 'RIGHT',
    severity: 'high',
    category: 'correctness',
    title: 'Null pointer risk',
    body: 'Potential null pointer dereference here.',
    evidence: 'new code',
    confidence: 0.9,
  };

  function setup(opts: {
    labels?: string[];
    comments?: GitHubIssueComment[];
    reviewComments?: GitHubReviewComment[];
    reviews?: GitHubReview[];
    compareFiles?: GitHubPullRequestFile[];
    compareStatus?: 'ahead' | 'diverged' | 'behind';
    totalCommits?: number;
    modelFindings?: Array<Record<string, unknown>>;
    compareThrows?: boolean;
    modelThrows?: boolean;
  } = {}) {
    const createdReviews: CreateReviewParams[] = [];
    const createdIssueComments: Array<{ body: string }> = [];
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
    };

    const fakeClient: Partial<GitHubClient> = {
      async listPullRequestFilesPage() {
        return [
          {
            filename: 'src/main.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -4,3 +4,4 @@\n context\n+new code\n context2',
          },
        ];
      },
      async getPullRequest() {
        return { head: { sha: headSha } };
      },
      async listReviewsPage() {
        return opts.reviews ?? [];
      },
      async listReviewCommentsPage() {
        return opts.reviewComments ?? [];
      },
      async listIssueCommentsPage() {
        return opts.comments ?? [];
      },
      async createIssueComment(params) {
        createdIssueComments.push(params);
        return { id: 301, body: params.body };
      },
      async createReview(params) {
        createdReviews.push(params);
        return { id: 999 };
      },
      async compareCommits() {
        if (opts.compareThrows) throw new Error('502 Bad Gateway');
        if (opts.compareStatus === undefined && !opts.compareFiles) return null;
        return {
          status: opts.compareStatus ?? 'ahead',
          files: opts.compareFiles ?? [
            {
              filename: 'src/main.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -4,3 +4,4 @@\n context\n+new code\n context2',
            },
          ],
          ...(opts.totalCommits !== undefined ? { totalCommits: opts.totalCommits } : { totalCommits: 2 }),
        };
      },
    };

    let modelInvoked = false;
    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      outputTokensFor: (n: number) => n,
      generate: vi.fn(async () => {
        modelInvoked = true;
        if (opts.modelThrows) throw Object.assign(new Error('boom'), { code: 'NETWORK' });
        return {
          text: JSON.stringify({
            summary: 'Review completed',
            findings: opts.modelFindings ?? [sampleFinding],
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }),
    };

    return {
      client: fakeClient as GitHubClient,
      model: fakeModel,
      isModelInvoked: () => modelInvoked,
      createdReviews,
      createdIssueComments,
      logs,
      log,
    };
  }

  const run = (env: ReturnType<typeof setup>) =>
    executeReview({
      client: env.client,
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      headSha,
      baseSha,
      prTitle: 'Feature',
      prBody: '',
      config,
      configHash,
      rulesFiles: [],
      model: env.model,
      publisherLogin: 'mergepilot[bot]',
      log: env.log,
    });

  const reviewBy = (login: string, sha: string, extra = '') => ({
    id: 10,
    user: { login },
    body: `Earlier review
<!-- mergepilot:review head=${sha} config=${configHash}${extra} -->`,
  });

  it('calls no model and publishes nothing when the head was already reviewed', async () => {
    const env = setup({ reviews: [reviewBy('mergepilot[bot]', headSha)] });
    const result = await run(env);
    expect(result.outcome).toBe('skipped');
    expect(result.publish.status).toBe('skipped-no-changes');
    expect(env.isModelInvoked()).toBe(false);
    expect(env.createdReviews).toHaveLength(0);
  });

  it('falls back to a full review when the compare API fails', async () => {
    const env = setup({ reviews: [reviewBy('mergepilot[bot]', prevSha)], compareThrows: true });
    const result = await run(env);
    expect(result.outcome).toBe('completed');
    expect(env.createdReviews[0]?.body).toContain('Full review (comparison unavailable)');
  });

  it('does not use a partial (failed) review as the incremental base', async () => {
    const env = setup({ reviews: [reviewBy('mergepilot[bot]', prevSha, ' status=partial')], compareStatus: 'ahead' });
    const result = await run(env);
    expect(result.outcome).toBe('completed');
    expect(env.createdReviews[0]?.body).toContain('Full review (first review)');
  });

  it('marks a failed review partial so the next push reviews its commits again', async () => {
    const env = setup({ modelThrows: true });
    const result = await run(env);
    expect(result.outcome).toBe('failed');
    expect(env.createdReviews[0]?.body).toContain(`head=${headSha} config=${configHash} status=partial`);
  });

  it('performs incremental review when previous review marker exists and commits are ahead', async () => {
    const { client, model, isModelInvoked, createdReviews, log } = setup({
      reviews: [
        {
          id: 10,
          user: { login: 'mergepilot[bot]' },
          body: `Earlier review summary\n<!-- mergepilot:review head=${prevSha} config=${configHash} -->`,
          state: 'COMMENTED',
          submitted_at: '2026-10-12T09:00:00Z',
        },
      ],
      compareStatus: 'ahead',
      totalCommits: 3,
    });

    const result = await executeReview({
      client,
      owner: 'acme',
      repo: 'repo',
      pullNumber: 42,
      headSha,
      baseSha,
      prTitle: 'Feature update',
      prBody: '',
      config,
      configHash,
      rulesFiles: [],
      model,
      publisherLogin: 'mergepilot[bot]',
      log,
    });

    expect(result.outcome).toBe('completed');
    expect(isModelInvoked()).toBe(true);
    expect(createdReviews).toHaveLength(1);
    const reviewBody = createdReviews[0]?.body ?? '';
    expect(reviewBody).toContain(`Reviewed 3 new commits since \`${prevSha.slice(0, 7)}\``);
  });

  const fingerprint = computeFindingFingerprint({
    id: 'x',
    path: 'src/main.ts',
    line: 5,
    side: 'RIGHT',
    severity: 'high',
    category: 'correctness',
    title: 'Null pointer risk',
    body: '',
    evidence: '',
    confidence: 0.9,
  });
  const markedBody = ['### Null pointer risk', '', `<!-- mp:f=${fingerprint} -->`].join('\n');
  const existingComment = (login: string, body: string) => ({
    id: 501,
    path: 'src/main.ts',
    line: 5,
    side: 'RIGHT',
    user: { login },
    body,
  });

  it('publishes the finding when no earlier comment matches', async () => {
    const env = setup({ modelFindings: [sampleFinding] });
    await run(env);
    const comments = env.createdReviews[0]?.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`<!-- mp:f=${fingerprint} -->`);
  });

  it('drops a finding whose fingerprint was already posted by this publisher', async () => {
    const env = setup({
      reviewComments: [existingComment('mergepilot[bot]', markedBody)],
      modelFindings: [sampleFinding],
    });
    const result = await run(env);
    expect(result.outcome).toBe('completed');
    expect(env.createdReviews[0]?.comments ?? []).toHaveLength(0);
  });

  it('drops a finding the GitHub Action already posted (cross-path, fingerprint from another bot)', async () => {
    const env = setup({
      reviewComments: [existingComment('github-actions[bot]', markedBody)],
      modelFindings: [sampleFinding],
    });
    await run(env);
    expect(env.createdReviews[0]?.comments ?? []).toHaveLength(0);
  });

  it('does not let a human-pasted fingerprint suppress a finding', async () => {
    const env = setup({
      reviewComments: [existingComment('mallory', markedBody)],
      modelFindings: [sampleFinding],
    });
    await run(env);
    expect(env.createdReviews[0]?.comments ?? []).toHaveLength(1);
  });

  it('drops a legacy (pre-fingerprint) comment match by title similarity', async () => {
    const legacy = ['### Null pointer risk!', '', '**Severity:** `HIGH`'].join('\n');
    const env = setup({
      reviewComments: [existingComment('mergepilot[bot]', legacy)],
      modelFindings: [sampleFinding],
    });
    await run(env);
    expect(env.createdReviews[0]?.comments ?? []).toHaveLength(0);
  });
});

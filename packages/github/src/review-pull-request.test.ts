import { describe, expect, it, vi } from 'vitest';
import type { ReviewModel } from '@mergepilot/engine';
import { Secret } from '@mergepilot/engine';
import type {
  CreateReviewParams,
  GitHubClient,
  GitHubPullRequest,
} from './client.js';
import { buildMarker } from './marker.js';
import {
  loadRepoConfig,
  reviewPullRequest,
  type ReviewPullRequestContext,
} from './review-pull-request.js';

describe('loadRepoConfig', () => {
  const baseSha = 'base-sha-123';
  const owner = 'test-owner';
  const repo = 'test-repo';

  it('returns missing: true when .mergepilot.yml does not exist at baseSha', async () => {
    const requestedRefs: Array<{ path: string; ref: string }> = [];
    const client: GitHubClient = {
      getFileContent: async ({ path, ref }) => {
        requestedRefs.push({ path, ref });
        return null;
      },
      listPullRequestFilesPage: async () => [],
      getPullRequest: async () => ({ head: { sha: 'head-sha' } }),
      listReviewsPage: async () => [],
      createReview: async () => ({ id: 1 }),
      compareCommits: async () => null,
    };

    const result = await loadRepoConfig(client, { owner, repo, baseSha });

    expect(result).toEqual({ missing: true });
    expect(requestedRefs).toEqual([{ path: '.mergepilot.yml', ref: baseSha }]);
  });

  it('returns errors when .mergepilot.yml is invalid YAML/config', async () => {
    const client: GitHubClient = {
      getFileContent: async () => 'broken: yaml: [',
      listPullRequestFilesPage: async () => [],
      getPullRequest: async () => ({ head: { sha: 'head-sha' } }),
      listReviewsPage: async () => [],
      createReview: async () => ({ id: 1 }),
      compareCommits: async () => null,
    };

    const result = await loadRepoConfig(client, { owner, repo, baseSha });

    expect('errors' in result).toBe(true);
    if ('errors' in result) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('reads config and rules files at base sha (not head)', async () => {
    const configYaml = `
provider: anthropic
model: claude-3-5-sonnet
language: en
review:
  rulesFiles:
    - CLAUDE.md
`;
    const requestedRefs: Array<{ path: string; ref: string }> = [];
    const client: GitHubClient = {
      getFileContent: async ({ path, ref }) => {
        requestedRefs.push({ path, ref });
        if (path === '.mergepilot.yml') return configYaml;
        if (path === 'CLAUDE.md') return '# Guidelines from base';
        return null;
      },
      listPullRequestFilesPage: async () => [],
      getPullRequest: async () => ({ head: { sha: 'head-sha' } }),
      listReviewsPage: async () => [],
      createReview: async () => ({ id: 1 }),
      compareCommits: async () => null,
    };

    const result = await loadRepoConfig(client, { owner, repo, baseSha });

    expect('config' in result).toBe(true);
    if ('config' in result) {
      expect(result.config.provider).toBe('anthropic');
      expect(result.config.model).toBe('claude-3-5-sonnet');
      expect(result.configText).toBe(configYaml);
      expect(result.rulesFiles).toEqual([
        { path: 'CLAUDE.md', content: '# Guidelines from base' },
      ]);
    }
    // All reads must target baseSha
    expect(requestedRefs).toHaveLength(2);
    for (const req of requestedRefs) {
      expect(req.ref).toBe(baseSha);
    }
  });
});

describe('reviewPullRequest', () => {
  const headSha = 'head-sha-999';
  const baseSha = 'base-sha-111';
  const owner = 'test-owner';
  const repo = 'test-repo';

  function createSetup() {
    const createdReviews: CreateReviewParams[] = [];
    const logs: string[] = [];

    const fakeClient: GitHubClient = {
      listPullRequestFilesPage: async () => [
        {
          filename: 'src/app.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1,1 +1,2 @@\n existing\n+new line',
        },
      ],
      getPullRequest: async (): Promise<GitHubPullRequest> => ({
        head: { sha: headSha },
      }),
      listReviewsPage: async () => [],
      createReview: async (params) => {
        createdReviews.push(params);
        return { id: 7001 };
      },
      getFileContent: async () => null,
      compareCommits: async () => null,
    };

    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async () => ({
        text: JSON.stringify({
          summary: 'Review completed cleanly.',
          findings: [
            {
              id: 'f-1',
              path: 'src/app.ts',
              line: 2,
              side: 'RIGHT' as const,
              title: 'Check added line',
              body: 'Verify this logic.',
              severity: 'medium' as const,
              category: 'correctness' as const,
              evidence: '+new line',
              confidence: 0.95,
            },
          ],
        }),
        finishReason: 'stop' as const,
        usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })),
    };

    const ctx: ReviewPullRequestContext = {
      client: fakeClient,
      owner,
      repo,
      pullNumber: 42,
      headSha,
      baseSha,
      prTitle: 'Add features',
      prBody: 'PR description',
      config: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        language: 'en',
        review: {
          maxFindings: 5,
          minSeverity: 'medium',
          exclude: [],
          rulesFiles: [],
          pathInstructions: [],
          verify: false,
          libraryDocs: { source: 'none', maxCharsPerLibrary: 8000, maxLibraries: 5 },
        },
        budget: {
          perReviewUsd: 1.0,
          maxInputTokens: 200000,
          pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 3.0, cacheWritePerMTok: 3.0 },
        },
        audit: { enabled: false, output: 'summary', maxFiles: 200, include: ['**/*'], exclude: [] },
      },
      configHash: 'a1b2c3d4e5f6',
      rulesFiles: [],
      model: fakeModel,
      knownSecrets: [new Secret('sk-ant-test-000')],
      publisherLogin: 'mergepilot[bot]',
      log: (msg) => logs.push(msg),
    };

    return { ctx, fakeClient, fakeModel, createdReviews, logs };
  }

  it('happy path publishes review once with COMMENT event and marker and returns outcome completed', async () => {
    const { ctx, createdReviews } = createSetup();

    const result = await reviewPullRequest(ctx);

    expect(result.outcome).toBe('completed');
    expect(result.costUsd).toBeCloseTo(0.003, 3);
    expect(result.publish.status).toBe('published');
    expect(result.publish.status === 'published' && result.publish.reviewId).toBe(7001);

    expect(createdReviews).toHaveLength(1);
    const review = createdReviews[0];
    expect(review?.event).toBe('COMMENT');
    expect(review?.commit_id).toBe(headSha);
    expect(review?.body).toContain('<!-- mergepilot:');
    expect(review?.body).toContain(headSha);
    expect(review?.comments).toHaveLength(1);
    expect(review?.comments?.[0]?.path).toBe('src/app.ts');
  });

  it('detects duplicate review and returns skipped-duplicate', async () => {
    const { ctx, fakeClient, createdReviews } = createSetup();

    fakeClient.listReviewsPage = async () => [
      {
        id: 999,
        body: `Previous review\n\n${buildMarker({ headSha, configHash: ctx.configHash })}`,
        user: { login: 'mergepilot[bot]' },
      },
    ];

    const result = await reviewPullRequest(ctx);

    expect(result.publish.status).toBe('skipped-duplicate');
    expect(createdReviews).toHaveLength(0);
  });

  it('detects stale head sha and returns skipped-stale', async () => {
    const { ctx, fakeClient, createdReviews } = createSetup();

    fakeClient.getPullRequest = async () => ({
      head: { sha: 'newer-sha-than-expected' },
    });

    const result = await reviewPullRequest(ctx);

    expect(result.publish.status).toBe('skipped-stale');
    expect(createdReviews).toHaveLength(0);
  });

  it('handles budget skip and publishes summary-only', async () => {
    const { ctx, createdReviews } = createSetup();
    ctx.config.budget.maxInputTokens = 1; // triggers budget check failure

    const result = await reviewPullRequest(ctx);

    expect(result.outcome).toBe('skipped-budget');
    expect(result.detail).toContain('maxInputTokens');
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]?.comments).toHaveLength(0);
    expect(createdReviews[0]?.body).toContain('maxInputTokens');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Secret, type ReviewModel } from '@mergepilot/engine';
import type {
  CreateReviewParams,
  GetFileContentParams,
  GetPullRequestParams,
  GitHubClient,
  GitHubPullRequest,
  ListFilesPageParams,
  ListReviewsPageParams,
} from '@mergepilot/github';
import { MemoryStore } from '../core/memory-store.js';
import type { ApiProvider, ReviewJob } from '../core/types.js';
import { processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';

describe('processReviewJob - details and metadata recording', () => {
  const headSha = 'sha-head-222';
  const baseSha = 'sha-base-000';
  const repoFullName = 'acme/repo-k1';
  const deliveryId = 'del-k1-123';
  const installationId = 77;
  const workspaceId = 'ws-details-test';

  function createSetup(options?: {
    modelFindings?: Array<Record<string, unknown>>;
    secretValue?: string;
    modelError?: Error;
  }) {
    const store = new MemoryStore();

    store.upsertInstallation({
      id: installationId,
      workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });

    store.saveSettings({
      workspaceId,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      language: 'en',
      monthlyBudgetUsd: null,
    });

    const secretValue = options?.secretValue ?? 'sk-test-fake-key-000';
    const credentials = {
      resolve: vi.fn(async (_wsId: string, _provider: ApiProvider) => {
        return new Secret(secretValue);
      }),
    };

    const createdReviews: CreateReviewParams[] = [];
    const fakeClient: GitHubClient = {
      getFileContent: async (_params: GetFileContentParams) => null,
      listPullRequestFilesPage: async (_params: ListFilesPageParams) => [
        {
          filename: 'src/app.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1,1 +1,2 @@\n context\n+added line',
        },
      ],
      getPullRequest: async (_params: GetPullRequestParams): Promise<GitHubPullRequest> => ({
        head: { sha: headSha },
      }),
      listReviewsPage: async (_params: ListReviewsPageParams) => [],
      createReview: async (params: CreateReviewParams) => {
        createdReviews.push(params);
        return { id: 999 };
      },
      compareCommits: async () => null,
    };

    const githubAppFactory = vi.fn(async () => ({
      client: fakeClient,
      publisherLogin: 'mergepilot[bot]',
    }));

    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async () => {
        if (options?.modelError) {
          throw options.modelError;
        }
        return {
          text: JSON.stringify({
            summary: 'Review summary header\n- Highlight 1',
            findings: options?.modelFindings ?? [],
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 150, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }),
    };

    const createModelForProvider = vi.fn(async () => fakeModel);

    const deps: ProcessReviewDeps = {
      store,
      credentials,
      githubAppFactory,
      createModelForProvider,
      now: () => new Date('2026-10-12T12:00:00Z'),
    };

    const job: ReviewJob = {
      deliveryId,
      installationId,
      repoFullName,
      pullNumber: 42,
      headSha,
      baseSha,
    };

    return { deps, store, job, createdReviews, fakeModel, secretValue };
  }

  it('records provider, model, findingsCount, result, and reviewUrl on completion', async () => {
    const { deps, job, store } = createSetup({
      modelFindings: [
        {
          path: 'src/app.ts',
          line: 2,
          severity: 'high',
          category: 'security',
          title: 'Dangerous operation',
          body: 'Avoid this pattern',
          evidence: 'added line',
          confidence: 0.95,
        },
      ],
    });

    const result = await processReviewJob(job, deps);
    expect(result.status).toBe('completed');

    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.provider).toBe('anthropic');
    expect(run?.model).toBe('claude-3-5-sonnet');
    expect(run?.findingsCount).toBe(1);
    expect(run?.reviewUrl).toBe('https://github.com/acme/repo-k1/pull/42#pullrequestreview-999');
    expect(run?.result).toBeDefined();
    expect(run?.result?.v).toBe(1);
    expect(run?.result?.findings).toHaveLength(1);
    expect(run?.result?.findings[0]?.title).toBe('Dangerous operation');
  });

  it('redacts secrets placed in finding body before storing result', async () => {
    // Runtime-built fake secret (no secret literal!)
    const p1 = 'sk-';
    const p2 = 'ant-';
    const p3 = 'test-token-value-secret-1234567890';
    const fakeSecret = `${p1}${p2}${p3}`;

    const { deps, job, store } = createSetup({
      secretValue: fakeSecret,
      modelFindings: [
        {
          path: 'src/app.ts',
          line: 2,
          severity: 'critical',
          category: 'security',
          title: 'Secret leaked',
          body: `The token is ${fakeSecret} here`,
          evidence: 'added line',
          confidence: 1,
        },
      ],
    });

    await processReviewJob(job, deps);

    const runs = await store.listReviewRuns(workspaceId, 10);
    const run = runs[0];
    expect(run?.result).toBeDefined();
    const findingBody = run?.result?.findings[0]?.body;
    expect(findingBody).not.toContain(fakeSecret);
    expect(findingBody).toContain('[REDACTED:');
  });

  it('reuses the existing review run when BullMQ retries the same job', async () => {
    const { deps, job, store } = createSetup();

    // First attempt creates row
    await processReviewJob(job, deps);
    const runsAfterFirst = await store.listReviewRuns(workspaceId, 10);
    expect(runsAfterFirst).toHaveLength(1);
    const firstRunId = runsAfterFirst[0]?.id;

    // Second attempt (retry of same job deliveryId)
    await processReviewJob(job, deps);
    const runsAfterRetry = await store.listReviewRuns(workspaceId, 10);
    expect(runsAfterRetry).toHaveLength(1);
    expect(runsAfterRetry[0]?.id).toBe(firstRunId);
  });

  it('records provider and model for failed runs when known', async () => {
    const { deps, job, store } = createSetup({
      modelError: new Error('Rate limit exceeded'),
    });

    const result = await processReviewJob(job, deps);
    expect(result.status).toBe('failed');

    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.status).toBe('failed');
    expect(run?.provider).toBe('anthropic');
    expect(run?.model).toBe('claude-3-5-sonnet');
  });
});

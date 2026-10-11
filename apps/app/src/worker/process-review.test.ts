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
import type { ApiProvider, Installation, ReviewJob, WorkspaceSettings } from '../core/types.js';
import { processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';

describe('processReviewJob', () => {
  const headSha = 'sha-head-111';
  const baseSha = 'sha-base-000';
  const repoFullName = 'acme/repo';
  const deliveryId = 'del-123';
  const installationId = 42;
  const workspaceId = 'ws-test-1';

  function createTestSetup(options?: {
    installation?: Partial<Installation> | null;
    settings?: Partial<WorkspaceSettings> | null;
    filesAtRef?: Record<string, string>;
    monthlyCost?: number;
    modelError?: Error;
    modelCostUsd?: number;
    secretValue?: string;
  }) {
    const store = new MemoryStore();

    if (options?.installation !== null) {
      store.upsertInstallation({
        id: installationId,
        workspaceId,
        accountLogin: 'acme',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
        ...options?.installation,
      });
    }

    if (options?.settings !== null) {
      store.saveSettings({
        workspaceId,
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        language: 'en',
        monthlyBudgetUsd: null,
        ...options?.settings,
      });
    }

    if (options?.monthlyCost !== undefined) {
      // Seed a completed run from this month with cost
      store.createReviewRun({
        workspaceId,
        installationId,
        repoFullName,
        pullNumber: 1,
        headSha: 'old-sha',
        status: 'completed',
        costUsd: options.monthlyCost,
        detail: null,
      });
    }

    const secretValue = options?.secretValue ?? 'sk-test-super-secret-key-123';
    const resolvedCredentials: Array<{ workspaceId: string; provider: ApiProvider }> = [];
    const credentials = {
      resolve: vi.fn(async (wsId: string, provider: ApiProvider) => {
        resolvedCredentials.push({ workspaceId: wsId, provider });
        return new Secret(secretValue);
      }),
    };

    const filesAtRef = options?.filesAtRef ?? {};
    const createdReviews: CreateReviewParams[] = [];

    const fakeClient: GitHubClient = {
      getFileContent: async (params: GetFileContentParams) => {
        const key = `${params.ref}:${params.path}`;
        return filesAtRef[key] ?? null;
      },
      listPullRequestFilesPage: async (_params: ListFilesPageParams) => [
        {
          filename: 'src/main.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1,1 +1,2 @@\n test\n+added',
        },
      ],
      getPullRequest: async (_params: GetPullRequestParams): Promise<GitHubPullRequest> => ({
        head: { sha: headSha },
      }),
      listReviewsPage: async (_params: ListReviewsPageParams) => [],
      createReview: async (params: CreateReviewParams) => {
        createdReviews.push(params);
        return { id: 808 };
      },
      compareCommits: async () => null,
    };

    const githubAppFactory = vi.fn(async (_instId: number) => ({
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
            summary: 'All checks passed.',
            findings: [],
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }),
    };

    const createModelForProvider = vi.fn(async () => fakeModel);
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const deps: ProcessReviewDeps = {
      store,
      credentials,
      githubAppFactory,
      createModelForProvider,
      log,
      now: () => new Date('2026-10-12T12:00:00Z'),
    };

    const job: ReviewJob = {
      deliveryId,
      installationId,
      repoFullName,
      pullNumber: 99,
      headSha,
      baseSha,
    };

    return {
      deps,
      store,
      job,
      createdReviews,
      logs,
      resolvedCredentials,
      credentials,
      createModelForProvider,
      fakeClient,
      fakeModel,
      secretValue,
    };
  }

  it('skips unknown installation without creating a review run', async () => {
    const { deps, job, store } = createTestSetup({ installation: null });

    const result = await processReviewJob(job, deps);

    expect(result.status).toBe('skipped');
    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(0);
  });

  it('skips suspended installation without creating a review run', async () => {
    const { deps, job, store } = createTestSetup({
      installation: { suspended: true },
    });

    const result = await processReviewJob(job, deps);

    expect(result.status).toBe('skipped');
    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(0);
  });

  it('records skipped with "workspace not configured" when settings are missing', async () => {
    const { deps, job, store } = createTestSetup({ settings: null });

    const result = await processReviewJob(job, deps);

    expect(result.status).toBe('skipped');
    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('skipped');
    expect(runs[0]?.detail).toBe('workspace not configured');
  });

  it('rejects claude-code override in repo config and records skipped', async () => {
    const claudeCodeYaml = `
provider: claude-code
language: en
review:
  maxFindings: 5
`;
    const { deps, job, store } = createTestSetup({
      filesAtRef: {
        [`${baseSha}:.mergepilot.yml`]: claudeCodeYaml,
      },
    });

    const result = await processReviewJob(job, deps);

    expect(result.status).toBe('skipped');
    expect(result.detail).toBe('subscription mode is not available in the SaaS');

    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('skipped');
    expect(runs[0]?.detail).toBe('subscription mode is not available in the SaaS');
  });

  it('publishes summary-only and makes no model call when monthly budget reached', async () => {
    const { deps, job, store, createdReviews, createModelForProvider } = createTestSetup({
      settings: { monthlyBudgetUsd: 10.0 },
      monthlyCost: 10.5, // already over budget
    });

    const result = await processReviewJob(job, deps);

    expect(result.status).toBe('skipped');
    expect(result.detail).toBe('monthly budget reached');

    // Model factory was NOT called
    expect(createModelForProvider).not.toHaveBeenCalled();

    // Summary-only review published
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]?.comments).toHaveLength(0);
    expect(createdReviews[0]?.body).toContain('monthly budget reached');

    // Run finished as skipped
    const runs = await store.listReviewRuns(workspaceId, 10);
    const jobRun = runs.find((r) => r.pullNumber === job.pullNumber);
    expect(jobRun).toBeDefined();
    expect(jobRun?.status).toBe('skipped');
    expect(jobRun?.detail).toBe('monthly budget reached');
  });

  it('successful review records cost and completes run', async () => {
    const { deps, job, store, createdReviews } = createTestSetup();

    const result = await processReviewJob(job, deps);

    expect(result.status).toBe('completed');
    expect(createdReviews).toHaveLength(1);

    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.costUsd).toBeDefined();
    expect(runs[0]?.finishedAt).not.toBeNull();
  });

  it('records failed with redacted detail and never logs secret when review fails', async () => {
    const secretValue = 'sk-ant-very-secret-token-xyz';
    const { deps, job, store, logs } = createTestSetup({
      secretValue,
      modelError: new Error(`Authentication failed with key: ${secretValue}`),
    });

    const result = await processReviewJob(job, deps);

    expect(result.status).toBe('failed');
    // Secret must NOT be in the result detail
    expect(result.detail).not.toContain(secretValue);
    expect(result.detail).toContain('[REDACTED:known]');

    // Secret must NOT be in any logged message
    for (const logMsg of logs) {
      expect(logMsg).not.toContain(secretValue);
    }

    // Run must be marked failed with redacted detail in store
    const runs = await store.listReviewRuns(workspaceId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.detail).not.toContain(secretValue);
    expect(runs[0]?.detail).toContain('[REDACTED:known]');
  });

  it('enforces workspace isolation: job for installation X only accesses X workspace credentials', async () => {
    const { deps, job, resolvedCredentials } = createTestSetup();

    // Add a second workspace and installation to the store
    const store = deps.store;
    await store.upsertInstallation({
      id: 999,
      workspaceId: 'ws-other-2',
      accountLogin: 'other-org',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });
    await store.saveSettings({
      workspaceId: 'ws-other-2',
      provider: 'openai',
      model: 'gpt-4o',
      language: 'ar',
      monthlyBudgetUsd: null,
    });

    // Run job for installation 42 (belongs to workspace ws-test-1)
    await processReviewJob(job, deps);

    // Verify resolved credentials were ONLY for ws-test-1, never ws-other-2
    expect(resolvedCredentials).toHaveLength(1);
    expect(resolvedCredentials[0]?.workspaceId).toBe('ws-test-1');
    expect(resolvedCredentials[0]?.workspaceId).not.toBe('ws-other-2');

    // Check review runs in store: ws-test-1 has runs, ws-other-2 has none
    const runsWs1 = await store.listReviewRuns('ws-test-1', 10);
    const runsWs2 = await store.listReviewRuns('ws-other-2', 10);
    expect(runsWs1).toHaveLength(1);
    expect(runsWs2).toHaveLength(0);
  });
});

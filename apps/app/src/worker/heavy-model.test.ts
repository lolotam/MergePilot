import { describe, expect, it, vi } from 'vitest';
import { Secret, type MergePilotConfig, type ReviewModel } from '@mergepilot/engine';
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
import type { ApiProvider, ReviewJob, WorkspaceSettings } from '../core/types.js';
import { processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';

describe('worker - heavy model, effort, fallback & minSeverity', () => {
  const headSha = 'sha-head-heavy';
  const baseSha = 'sha-base-heavy';
  const repoFullName = 'acme/heavy-repo';
  const deliveryId = 'del-heavy-123';
  const installationId = 77;
  const workspaceId = 'ws-heavy-1';

  function createTestHarness(options: {
    settings: Partial<WorkspaceSettings>;
    additions?: number;
    deletions?: number;
    customBaseUrl?: string;
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
      ...options.settings,
    });

    if (options.customBaseUrl) {
      store.saveCredential({
        workspaceId,
        provider: 'custom',
        ciphertext: 'cipher',
        last4: '0000',
        createdBy: 'user',
        baseUrl: options.customBaseUrl,
      });
    }

    const resolvedSecrets = new Map<string, Secret>();
    const credentials = {
      resolve: vi.fn(async (_wsId: string, provider: ApiProvider) => {
        const s = new Secret(`sk-test-${provider}-val`);
        resolvedSecrets.set(provider, s);
        return s;
      }),
    };

    const fakeClient: GitHubClient = {
      getFileContent: async (_params: GetFileContentParams) => null,
      listPullRequestFilesPage: async (_params: ListFilesPageParams) => [],
      getPullRequest: async (_params: GetPullRequestParams): Promise<GitHubPullRequest> => ({
        head: { sha: headSha },
        title: 'Heavy PR',
        body: 'Large changes',
        additions: options.additions ?? 50,
        deletions: options.deletions ?? 50,
      } as unknown as GitHubPullRequest),
      listReviewsPage: async (_params: ListReviewsPageParams) => [],
      createReview: async (_params: CreateReviewParams) => ({ id: 999 }),
      compareCommits: async () => null,
    };

    const githubAppFactory = vi.fn(async () => ({
      client: fakeClient,
      publisherLogin: 'mergepilot[bot]',
    }));

    let capturedConfig: MergePilotConfig | undefined;
    const fakeModel: ReviewModel = {
      label: 'test-model',
      generate: vi.fn(async () => ({
        text: JSON.stringify({ summary: 'LGTM', findings: [] }),
        finishReason: 'stop' as const,
        usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })),
    };

    const createModelForProvider = vi.fn(async (config: MergePilotConfig) => {
      capturedConfig = config;
      return fakeModel;
    });

    const deps: ProcessReviewDeps = {
      store,
      credentials,
      githubAppFactory,
      createModelForProvider,
    };

    const job: ReviewJob = {
      deliveryId,
      installationId,
      repoFullName,
      pullNumber: 101,
      headSha,
      baseSha,
    };

    return { store, deps, job, getCapturedConfig: () => capturedConfig };
  }

  it('uses heavy model and effort when additions + deletions >= heavyThresholdLines', async () => {
    const harness = createTestHarness({
      settings: {
        provider: 'anthropic',
        model: 'claude-3-5-haiku',
        effort: 'low',
        heavyProvider: 'openai',
        heavyModel: 'gpt-5-pro',
        heavyEffort: 'high',
        heavyThresholdLines: 500,
      },
      additions: 300,
      deletions: 250, // total = 550 >= 500
    });

    const result = await processReviewJob(harness.job, harness.deps);
    expect(result.status).toBe('completed');

    const config = harness.getCapturedConfig();
    expect(config?.provider).toBe('openai');
    expect(config?.model).toBe('gpt-5-pro');
    expect(config?.effort).toBe('high');

    const runs = await harness.store.listReviewRuns(workspaceId);
    const run = 'runs' in runs ? runs.runs[0] : runs[0];
    expect(run?.provider).toBe('openai');
    expect(run?.model).toBe('gpt-5-pro');
    expect(run?.effort).toBe('high');
  });

  it('uses default model and effort when additions + deletions < heavyThresholdLines', async () => {
    const harness = createTestHarness({
      settings: {
        provider: 'anthropic',
        model: 'claude-3-5-haiku',
        effort: 'low',
        heavyProvider: 'openai',
        heavyModel: 'gpt-5-pro',
        heavyEffort: 'high',
        heavyThresholdLines: 500,
      },
      additions: 100,
      deletions: 50, // total = 150 < 500
    });

    const result = await processReviewJob(harness.job, harness.deps);
    expect(result.status).toBe('completed');

    const config = harness.getCapturedConfig();
    expect(config?.provider).toBe('anthropic');
    expect(config?.model).toBe('claude-3-5-haiku');
    expect(config?.effort).toBe('low');

    const runs = await harness.store.listReviewRuns(workspaceId);
    const run = 'runs' in runs ? runs.runs[0] : runs[0];
    expect(run?.provider).toBe('anthropic');
    expect(run?.model).toBe('claude-3-5-haiku');
    expect(run?.effort).toBe('low');
  });

  it('passes fallback models and minSeverity to engine config', async () => {
    const harness = createTestHarness({
      settings: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        fallback: [
          { provider: 'openai', model: 'gpt-4o', effort: 'medium' },
          { provider: 'gemini', model: 'gemini-2.5-pro' },
        ],
        minSeverity: 'critical',
      },
      additions: 10,
      deletions: 10,
    });

    const result = await processReviewJob(harness.job, harness.deps);
    expect(result.status).toBe('completed');

    const config = harness.getCapturedConfig();
    expect(config?.review?.minSeverity).toBe('critical');
    expect(config?.fallback).toHaveLength(2);
    expect(config?.fallback[0]).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      effort: 'medium',
    });
    expect(config?.fallback[1]).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
    });
  });

  it('supplies baseUrl from stored credential for custom fallback provider', async () => {
    const harness = createTestHarness({
      settings: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        fallback: [{ provider: 'custom', model: 'llama-3.3' }],
      },
      customBaseUrl: 'https://llm.internal.corp/v1',
    });

    const result = await processReviewJob(harness.job, harness.deps);
    expect(result.status).toBe('completed');

    const config = harness.getCapturedConfig();
    expect(config?.fallback[0]?.baseUrl).toBe('https://llm.internal.corp/v1');
  });
});

import { vi } from 'vitest';
import { Secret, type FetchLike, type MergePilotConfig, type ReviewModel } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient, GitHubPullRequest } from '@mergepilot/github';
import { MemoryStore } from '../core/memory-store.js';
import type { ApiProvider, ReviewJob, WorkspaceSettings } from '../core/types.js';
import type { ProcessReviewDeps } from './types.js';

export const WORKSPACE_ID = 'ws-heavy-1';
const INSTALLATION_ID = 77;

/** A provider key built at runtime so no secret-looking literal sits in the tests. */
export const keyFor = (provider: string): string => ['tk', provider, 'q7'.repeat(6)].join('-');

/** One OpenAI-compatible SSE answer with an empty review. */
export function reviewStream(): Response {
  const content = JSON.stringify({ summary: 'LGTM', findings: [] });
  const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export interface HarnessOptions {
  settings: Partial<WorkspaceSettings>;
  additions?: number;
  deletions?: number;
  customBaseUrl?: string;
  /** Use the real engine model (with these seams) instead of the fake model. */
  engine?: { customFetch: FetchLike; publicIp?: string };
  fakeModel?: ReviewModel;
}

/** A worker harness: one installation, workspace settings, a fake GitHub client and run store. */
export function createHarness(options: HarnessOptions) {
  const store = new MemoryStore();
  store.upsertInstallation({
    id: INSTALLATION_ID,
    workspaceId: WORKSPACE_ID,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspended: false,
  });
  void store.saveSettings({
    workspaceId: WORKSPACE_ID,
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    language: 'en',
    monthlyBudgetUsd: null,
    ...options.settings,
  });
  if (options.customBaseUrl) {
    void store.saveCredential({
      id: 'cred-custom',
      workspaceId: WORKSPACE_ID,
      provider: 'custom',
      ciphertext: 'cipher',
      keyVersion: 1,
      last4: '0000',
      createdBy: 'user',
      createdAt: new Date(),
      baseUrl: options.customBaseUrl,
    });
  }

  const credentials = {
    resolve: vi.fn(async (_ws: string, provider: ApiProvider) => new Secret(keyFor(provider))),
  };
  const reviews: CreateReviewParams[] = [];
  const client: GitHubClient = {
    getFileContent: async () => null,
    listPullRequestFilesPage: async () => [
      { filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    ],
    getPullRequest: async () =>
      ({
        head: { sha: 'sha-head' },
        title: 'PR',
        body: '',
        additions: options.additions ?? 50,
        deletions: options.deletions ?? 50,
      }) as unknown as GitHubPullRequest,
    listReviewsPage: async () => [],
    createReview: async (params) => {
      reviews.push(params);
      return { id: 999 };
    },
    compareCommits: async () => null,
  };

  let capturedConfig: MergePilotConfig | undefined;
  const model: ReviewModel = options.fakeModel ?? {
    label: 'test-model',
    generate: vi.fn(async () => ({
      text: JSON.stringify({ summary: 'LGTM', findings: [] }),
      finishReason: 'stop' as const,
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })),
  };
  const publicIp = options.engine?.publicIp ?? '93.184.216.34';
  const deps: ProcessReviewDeps = {
    store,
    credentials,
    githubAppFactory: vi.fn(async () => ({ client, publisherLogin: 'mergepilot[bot]' })),
    ...(options.engine
      ? { customFetch: options.engine.customFetch, ssrfLookup: async () => [{ address: publicIp, family: 4 }] }
      : {
          createModelForProvider: vi.fn(async (config: MergePilotConfig) => {
            capturedConfig = config;
            return model;
          }),
        }),
  };
  const job: ReviewJob = {
    deliveryId: 'del-heavy-123',
    installationId: INSTALLATION_ID,
    repoFullName: 'acme/heavy-repo',
    pullNumber: 101,
    headSha: 'sha-head',
    baseSha: 'sha-base',
  };

  const latestRun = async () => {
    const runs = await store.listReviewRuns(WORKSPACE_ID);
    return 'runs' in runs ? runs.runs[0] : runs[0];
  };
  return { store, deps, job, reviews, credentials, latestRun, getCapturedConfig: () => capturedConfig };
}

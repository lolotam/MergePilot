import { describe, expect, it, vi } from 'vitest';
import type { ReviewModel } from '@mergepilot/engine';
import type {
  CreateReviewParams,
  GetFileContentParams,
  GetPullRequestParams,
  GitHubClient,
  GitHubPullRequest,
  ListFilesPageParams,
  ListReviewsPageParams,
} from '@mergepilot/github';
import { runPullRequestReview, type PullRequestReviewDeps } from './pull-request.js';

describe('runPullRequestReview — subscription mode & cost', () => {
  const baseSha = 'sha-base-000';
  const headSha = 'sha-head-111';

  function createValidEventPayload() {
    return {
      pull_request: {
        number: 42,
        draft: false,
        title: 'Feature: improve logging',
        body: 'This PR adds logging.',
        head: {
          sha: headSha,
          repo: { full_name: 'acme/repo' },
        },
        base: {
          sha: baseSha,
          repo: { full_name: 'acme/repo' },
        },
      },
    };
  }

  const claudeCodeConfigYaml = `
provider: claude-code
language: en
review:
  maxFindings: 5
  minSeverity: medium
  rulesFiles:
    - CLAUDE.md
budget:
  perReviewUsd: 1.0
  pricing:
    inputPerMTok: 3.0
    outputPerMTok: 15.0
`;

  interface TestSetupOptions {
    configYaml?: string;
    env?: Record<string, string | undefined>;
    workspaceFiles?: string[];
    modelGenerateMock?: (req: unknown) => Promise<{
      text: string;
      finishReason: 'stop';
      usage?: { inputTokens: number; outputTokens: number };
    }>;
  }

  function setupTest(options: TestSetupOptions = {}) {
    const configYaml = options.configYaml ?? claudeCodeConfigYaml;
    const eventJson = JSON.stringify(createValidEventPayload());
    const logs: string[] = [];
    const log = (msg: string): void => {
      logs.push(msg);
    };

    const filesAtRef: Record<string, string> = {
      [`${baseSha}:.mergepilot.yml`]: configYaml,
      [`${baseSha}:CLAUDE.md`]: '# Claude guidelines from base',
    };

    const env: Record<string, string | undefined> = {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: '/fake/event.json',
      GITHUB_REPOSITORY: 'acme/repo',
      GITHUB_TOKEN: 'sk-gh-token-test-123',
      GITHUB_WORKSPACE: '/fake/workspace',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-test-123',
      ...options.env,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path === '/fake/event.json') return eventJson;
      throw new Error(`File not found: ${path}`);
    };

    const createdReviews: CreateReviewParams[] = [];

    const fakeClient: GitHubClient = {
      async getFileContent(params: GetFileContentParams): Promise<string | null> {
        const key = `${params.ref}:${params.path}`;
        return filesAtRef[key] ?? null;
      },
      async listPullRequestFilesPage(_params: ListFilesPageParams) {
        return [
          {
            filename: 'src/index.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -1,1 +1,2 @@\n context\n+added line',
          },
        ];
      },
      async getPullRequest(_params: GetPullRequestParams): Promise<GitHubPullRequest> {
        return { head: { sha: headSha } };
      },
      async listReviewsPage(_params: ListReviewsPageParams) {
        return [];
      },
      async createReview(params: CreateReviewParams) {
        createdReviews.push(params);
        return { id: 1001 };
      },
    };

    const fakeModel: ReviewModel = {
      label: 'claude-code',
      generate:
        options.modelGenerateMock ??
        (async () => {
          return {
            text: JSON.stringify({
              summary: 'Looks good.',
              findings: [],
            }),
            finishReason: 'stop' as const,
            usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }),
    };

    let capturedModelOpts: { cwd: string; configDir?: string } | undefined;
    const createModel = vi.fn(async (_cfg, _store, opts) => {
      capturedModelOpts = opts;
      return fakeModel;
    });

    let cleanupCalled = false;
    let sandboxCreated = false;
    const fakeSandbox = {
      dir: '/tmp/fake-sandbox-dir',
      cleanup: vi.fn(async () => {
        cleanupCalled = true;
      }),
    };

    const createSanitizedWorkspace = vi.fn(async () => {
      sandboxCreated = true;
      return fakeSandbox;
    });

    const deps: PullRequestReviewDeps = {
      env,
      readFile,
      createClient: () => fakeClient,
      createModel,
      createSanitizedWorkspace,
      listFiles: async () => options.workspaceFiles ?? ['src/index.ts', 'package.json'],
      log,
      cwd: () => '/fake/workspace',
    };

    return {
      deps,
      logs,
      createdReviews,
      createModel,
      getCapturedModelOpts: () => capturedModelOpts,
      getCleanupCalled: () => cleanupCalled,
      getSandboxCreated: () => sandboxCreated,
      fakeSandbox,
      fakeClient,
    };
  }

  it('in claude-code mode: builds model with sandbox cwd and configDir, and cleans up on success', async () => {
    const { deps, getCapturedModelOpts, getCleanupCalled, getSandboxCreated } = setupTest();

    await runPullRequestReview(deps);

    expect(getSandboxCreated()).toBe(true);
    const opts = getCapturedModelOpts();
    expect(opts?.cwd).toBe('/tmp/fake-sandbox-dir');
    expect(opts?.configDir).toBeDefined();
    expect(typeof opts?.configDir).toBe('string');
    expect(getCleanupCalled()).toBe(true);
  });

  it('in claude-code mode: cleans up sandbox when review status is failed', async () => {
    const { deps, getCleanupCalled, fakeSandbox, createdReviews } = setupTest({
      modelGenerateMock: async () => {
        throw new Error('LLM model failure');
      },
    });

    await runPullRequestReview(deps);

    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]?.body).toContain('failed');
    expect(getCleanupCalled()).toBe(true);
    expect(fakeSandbox.cleanup).toHaveBeenCalled();
  });

  it('in claude-code mode: cleans up sandbox when an exception is thrown', async () => {
    const { deps, getCleanupCalled, fakeSandbox, fakeClient } = setupTest();
    fakeClient.createReview = async () => {
      throw new Error('GitHub network down');
    };

    await expect(runPullRequestReview(deps)).rejects.toThrow('GitHub network down');
    expect(getCleanupCalled()).toBe(true);
    expect(fakeSandbox.cleanup).toHaveBeenCalled();
  });

  it('fails with clear error telling user to add actions/checkout when workspace has no files', async () => {
    const { deps } = setupTest({
      workspaceFiles: [], // empty workspace
    });

    await expect(runPullRequestReview(deps)).rejects.toThrow(/actions\/checkout/i);
  });

  it('passes costUsd into renderReviewSummary when pricing is configured', async () => {
    const { deps, createdReviews } = setupTest();

    await runPullRequestReview(deps);

    expect(createdReviews).toHaveLength(1);
    const reviewBody = createdReviews[0]?.body ?? '';
    // costUsd: 1000 * 3/1e6 + 200 * 15/1e6 = 0.003 + 0.003 = 0.006
    expect(reviewBody).toContain('0.006');
    expect(reviewBody).toContain('Cost:');
  });
});

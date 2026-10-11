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
import { run, type ActionDeps } from './main.js';

describe('run action', () => {
  const baseSha = 'sha-base-000';
  const headSha = 'sha-head-111';

  function createValidEventPayload(overrides?: Record<string, unknown>) {
    return {
      pull_request: {
        number: 42,
        draft: false,
        title: 'Feature: improve logging',
        body: 'This PR adds logging to the auth service.',
        head: {
          sha: headSha,
          repo: { full_name: 'acme/repo' },
        },
        base: {
          sha: baseSha,
          repo: { full_name: 'acme/repo' },
        },
      },
      ...overrides,
    };
  }

  const validConfigYaml = `
provider: anthropic
model: claude-3-5-sonnet
language: en
review:
  maxFindings: 5
  minSeverity: medium
  rulesFiles:
    - CLAUDE.md
`;

  interface TestSetupOptions {
    eventName?: string;
    eventPayload?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    filesAtRef?: Record<string, string>; // key: `${ref}:${path}`
    prFiles?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string }>;
    modelResponseText?: string;
    modelGenerateMock?: (req: unknown) => Promise<{ text: string; finishReason: 'stop'; usage?: { inputTokens: number; outputTokens: number } }>;
  }

  function setupTest(options: TestSetupOptions = {}) {
    const eventName = options.eventName ?? 'pull_request';
    const eventPayload = options.eventPayload ?? createValidEventPayload();
    const eventJson = JSON.stringify(eventPayload);

    const logs: string[] = [];
    const log = (msg: string): void => {
      logs.push(msg);
    };

    const filesAtRef = options.filesAtRef ?? {
      [`${baseSha}:.mergepilot.yml`]: validConfigYaml,
      [`${baseSha}:CLAUDE.md`]: '# Claude guidelines',
    };

    const env: Record<string, string | undefined> = {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: '/fake/event.json',
      GITHUB_REPOSITORY: 'acme/repo',
      GITHUB_TOKEN: 'sk-gh-token-test-123',
      ANTHROPIC_API_KEY: 'sk-ant-test-key-456',
      ...options.env,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path === '/fake/event.json') return eventJson;
      throw new Error(`File not found: ${path}`);
    };

    const createdReviews: CreateReviewParams[] = [];
    const requestedFileContentRefs: Array<{ path: string; ref: string }> = [];

    const fakeClient: GitHubClient = {
      async getFileContent(params: GetFileContentParams): Promise<string | null> {
        requestedFileContentRefs.push({ path: params.path, ref: params.ref });
        const key = `${params.ref}:${params.path}`;
        return filesAtRef[key] ?? null;
      },
      async listPullRequestFilesPage(_params: ListFilesPageParams) {
        return (
          options.prFiles ?? [
            {
              filename: 'src/index.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -1,1 +1,2 @@\n context\n+added line',
            },
          ]
        );
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
      label: 'anthropic:claude-3-5-sonnet',
      generate:
        options.modelGenerateMock ??
        (async () => {
          return {
            text:
              options.modelResponseText ??
              JSON.stringify({
                summary: 'Looks good overall.',
                findings: [
                  {
                    id: 'f1',
                    path: 'src/index.ts',
                    line: 2,
                    side: 'RIGHT',
                    title: 'Minor issue',
                    body: 'Please verify this line.',
                    severity: 'medium',
                    category: 'correctness',
                    evidence: '+added line',
                    confidence: 0.9,
                  },
                ],
              }),
            finishReason: 'stop' as const,
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }),
    };

    const createModel = vi.fn(async () => fakeModel);

    const deps: ActionDeps = {
      env,
      readFile,
      createClient: () => fakeClient,
      createModel,
      log,
      cwd: () => '/fake/workspace',
    };

    return {
      deps,
      logs,
      createdReviews,
      requestedFileContentRefs,
      createModel,
    };
  }

  it('skips when event is not pull_request', async () => {
    const { deps, logs, createdReviews } = setupTest({ eventName: 'push' });

    await run(deps);

    expect(createdReviews).toHaveLength(0);
    expect(logs.some((l) => l.includes('not pull_request'))).toBe(true);
  });

  it('skips draft pull requests', async () => {
    const payload = createValidEventPayload();
    payload.pull_request.draft = true;

    const { deps, logs, createdReviews } = setupTest({ eventPayload: payload });

    await run(deps);

    expect(createdReviews).toHaveLength(0);
    expect(logs.some((l) => l.includes('draft PR'))).toBe(true);
  });

  it('skips fork pull requests and logs "skipped: fork PR has no secrets"', async () => {
    const payload = createValidEventPayload();
    payload.pull_request.head.repo.full_name = 'forker/repo';
    payload.pull_request.base.repo.full_name = 'acme/repo';

    const { deps, logs, createdReviews } = setupTest({ eventPayload: payload });

    await run(deps);

    expect(createdReviews).toHaveLength(0);
    expect(logs.some((l) => l.includes('skipped: fork PR has no secrets'))).toBe(true);
  });

  it('skips when .mergepilot.yml is missing on the base branch', async () => {
    const { deps, logs, createdReviews } = setupTest({
      filesAtRef: {}, // No files on base branch
    });

    await run(deps);

    expect(createdReviews).toHaveLength(0);
    expect(logs.some((l) => l.includes('not found') || l.includes('not configured'))).toBe(true);
  });

  it('fails when .mergepilot.yml is invalid', async () => {
    const { deps } = setupTest({
      filesAtRef: {
        [`${baseSha}:.mergepilot.yml`]: 'invalid: [yaml: broken',
      },
    });

    await expect(run(deps)).rejects.toThrow();
  });

  it('reads config and rules files at the base sha (not head)', async () => {
    const { deps, requestedFileContentRefs } = setupTest();

    await run(deps);

    expect(requestedFileContentRefs.length).toBeGreaterThan(0);
    for (const refCall of requestedFileContentRefs) {
      expect(refCall.ref).toBe(baseSha);
      expect(refCall.ref).not.toBe(headSha);
    }
  });

  it('happy path publishes review once with COMMENT event and marker', async () => {
    const { deps, createdReviews } = setupTest();

    await run(deps);

    expect(createdReviews).toHaveLength(1);
    const review = createdReviews[0];
    expect(review.event).toBe('COMMENT');
    expect(review.commit_id).toBe(headSha);
    expect(review.owner).toBe('acme');
    expect(review.repo).toBe('repo');
    expect(review.pull_number).toBe(42);
    // Hidden idempotency marker present in review body
    expect(review.body).toContain('<!-- mergepilot:');
    expect(review.body).toContain(headSha);
    // Inline comments mapped
    expect(review.comments).toBeDefined();
    expect(review.comments?.length).toBeGreaterThan(0);
  });

  it('budget skip publishes a summary-only review explaining why', async () => {
    // Configure low input tokens budget so checkBudget returns skipped-budget
    const lowBudgetYaml = `
provider: anthropic
model: claude-3-5-sonnet
language: en
review:
  maxFindings: 5
  minSeverity: medium
budget:
  maxInputTokens: 1
`;
    const { deps, createdReviews } = setupTest({
      filesAtRef: {
        [`${baseSha}:.mergepilot.yml`]: lowBudgetYaml,
      },
    });

    await run(deps);

    expect(createdReviews).toHaveLength(1);
    const review = createdReviews[0];
    expect(review.event).toBe('COMMENT');
    // Summary-only review has no inline comments
    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain('maxInputTokens');
  });

  it('failed outcome with INVALID_CREDENTIAL publishes summary naming the env var', async () => {
    const { deps, createdReviews } = setupTest({
      modelGenerateMock: async () => {
        const { LlmFailure } = await import('@mergepilot/engine');
        throw new LlmFailure({
          code: 'INVALID_CREDENTIAL',
          provider: 'anthropic',
          message: 'Invalid key',
        });
      },
    });

    await run(deps);

    expect(createdReviews).toHaveLength(1);
    const review = createdReviews[0];
    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain('ANTHROPIC_API_KEY');
  });

  it('failed outcome with QUOTA publishes summary naming the env var', async () => {
    const { deps, createdReviews } = setupTest({
      modelGenerateMock: async () => {
        const { LlmFailure } = await import('@mergepilot/engine');
        throw new LlmFailure({
          code: 'QUOTA',
          provider: 'anthropic',
          message: 'Quota exceeded',
        });
      },
    });

    await run(deps);

    expect(createdReviews).toHaveLength(1);
    const review = createdReviews[0];
    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain('ANTHROPIC_API_KEY');
  });

  it('allows overriding publisher login via INPUT_PUBLISHER-LOGIN', async () => {
    const { deps } = setupTest({
      env: {
        'INPUT_PUBLISHER-LOGIN': 'custom-bot[bot]',
      },
    });

    await run(deps);
  });
});

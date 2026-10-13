import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Secret, type ReviewModel } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { createLogger } from '../core/logger.js';
import type { ReviewJob } from '../core/types.js';
import { processReviewJob } from './process-review.js';
import { startRunHeartbeat } from './run-heartbeat.js';
import type { ProcessReviewDeps } from './types.js';

function createCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed) {
          try {
            lines.push(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            // ignore non-json
          }
        }
      }
      callback();
    },
  });
  return { stream, lines };
}

describe('Worker structured logging', () => {
  let store: MemoryStore;
  const workspaceId = 'ws-log-test';
  const installationId = 77;
  const deliveryId = 'del-job-42';
  const repoFullName = 'acme/repo';
  const pullNumber = 15;
  const headSha = '1234567890abcdef1234567890abcdef12345678';
  const baseSha = 'abcdef1234567890abcdef1234567890abcdef12';

  const job: ReviewJob = {
    deliveryId,
    installationId,
    repoFullName,
    pullNumber,
    headSha,
    baseSha,
  };

  beforeEach(() => {
    store = new MemoryStore();
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
  });

  it('logs job start and job end with provider, model, tokens, and duration, with NO key', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'worker', stream });

    const fakeKey = ['sk', 'ant', 'api03', 'w'.repeat(25)].join('-');
    const fakeSecret = new Secret(fakeKey);

    const mockModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({ summary: 'All good', findings: [] }),
        finishReason: 'stop' as const,
        usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    };

    const mockClient = {
      getFileContent: async () => null,
      listPullRequestFilesPage: async () => [
        { filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n test\n+added' },
      ],
      getPullRequest: async () => ({ head: { sha: headSha } }),
      listReviewsPage: async () => [],
      createReview: async () => ({ id: 999, html_url: 'https://github.com/acme/repo/pull/15#review-999' }),
      compareCommits: async () => null,
    };

    const deps: ProcessReviewDeps = {
      store,
      credentials: {
        resolve: vi.fn().mockResolvedValue(fakeSecret),
      },
      githubAppFactory: vi.fn().mockResolvedValue({
        client: mockClient as unknown as import('@mergepilot/github').GitHubClient,
        publisherLogin: 'mergepilot[bot]',
      }),
      createModelForProvider: vi.fn().mockResolvedValue(mockModel),
      logger,
    };

    const result = await processReviewJob(job, deps);
    expect(result.status).toBe('completed');

    // 1. Verify job start log line
    const startLine = lines.find((l) => l.event === 'job.start');
    expect(startLine).toBeDefined();
    expect(startLine?.jobId).toBe(deliveryId);
    expect(startLine?.workspace).toBe(workspaceId);
    expect(startLine?.repo).toBe(repoFullName);
    expect(startLine?.pullNumber).toBe(pullNumber);
    expect(startLine?.headSha).toBe(headSha.slice(0, 7));

    // 2. Verify job end log line
    const endLine = lines.find((l) => l.event === 'job.end');
    expect(endLine).toBeDefined();
    expect(endLine?.status).toBe('completed');
    expect(endLine?.provider).toBe('anthropic');
    expect(endLine?.model).toBe('claude-3-5-sonnet');
    expect(typeof endLine?.findingsCount).toBe('number');
    expect(typeof endLine?.inputTokens).toBe('number');
    expect(typeof endLine?.outputTokens).toBe('number');
    expect(typeof endLine?.durationMs).toBe('number');
    expect(endLine?.reviewUrl).toContain('https://github.com/acme/repo/pull/15');

    // Verify absolutely no key anywhere in logged lines
    const allLogsText = JSON.stringify(lines);
    expect(allLogsText).not.toContain(fakeKey);
  });

  it('logs at warn what the model said when it answered without JSON, but never in the run detail', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'worker', stream });
    const prose = 'No issues found in this diff.';
    const mockModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn().mockResolvedValue({ text: prose, finishReason: 'stop' as const }),
    };
    const mockClient = {
      getFileContent: async () => null,
      listPullRequestFilesPage: async () => [
        { filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n test\n+added' },
      ],
      getPullRequest: async () => ({ head: { sha: headSha } }),
      listReviewsPage: async () => [],
      createReview: async () => ({ id: 1000, html_url: 'https://github.com/acme/repo/pull/15#review-1000' }),
      compareCommits: async () => null,
    };
    const deps: ProcessReviewDeps = {
      store,
      credentials: { resolve: vi.fn().mockResolvedValue(new Secret('sk-test-unused')) },
      githubAppFactory: vi.fn().mockResolvedValue({
        client: mockClient as unknown as import('@mergepilot/github').GitHubClient,
        publisherLogin: 'mergepilot[bot]',
      }),
      createModelForProvider: vi.fn().mockResolvedValue(mockModel),
      logger,
    };

    const result = await processReviewJob(job, deps);
    expect(result.status).toBe('failed');

    const answerLine = lines.find((l) => l.event === 'review.unusable-answer');
    expect(answerLine?.level).toBe(40);
    expect(answerLine?.provider).toBe('anthropic');
    expect(answerLine?.attempts).toEqual([
      { chars: prose.length, finishReason: 'stop', preview: prose },
      { chars: prose.length, finishReason: 'stop', preview: prose },
    ]);
    expect(result.detail ?? '').not.toContain(prose);
  });

  it('logs failures at error level with failure code and redacted message', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'worker', stream });

    const fakeKey = ['sk', 'ant', 'api03', 'f'.repeat(25)].join('-');
    const deps: ProcessReviewDeps = {
      store,
      credentials: {
        resolve: vi.fn(),
      },
      githubAppFactory: vi.fn().mockResolvedValue({
        client: {
          getPullRequest: vi.fn().mockRejectedValue(new Error(`Failed to resolve key ${fakeKey}`)),
        } as unknown as import('@mergepilot/github').GitHubClient,
        publisherLogin: 'bot',
      }),
      logger,
    };

    const result = await processReviewJob(job, deps);
    expect(result.status).toBe('failed');

    const failLine = lines.find((l) => l.event === 'job.failed');
    expect(failLine).toBeDefined();
    expect(failLine?.level).toBe(50); // error level
    expect(failLine?.jobId).toBe(deliveryId);
    expect(failLine?.message).not.toContain(fakeKey);
    expect(failLine?.message).toContain('[REDACTED:anthropic]');
  });

  it('logs skipped jobs with skipped reason', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'worker', stream });

    const unlinkedJob: ReviewJob = {
      ...job,
      deliveryId: 'del-unknown-inst',
      installationId: 9999, // unknown installation
    };

    const deps: ProcessReviewDeps = {
      store,
      credentials: { resolve: vi.fn() },
      githubAppFactory: vi.fn(),
      logger,
    };

    const result = await processReviewJob(unlinkedJob, deps);
    expect(result.status).toBe('skipped');

    const skipLine = lines.find((l) => l.event === 'job.skipped');
    expect(skipLine).toBeDefined();
    expect(skipLine?.jobId).toBe('del-unknown-inst');
    expect(skipLine?.reason).toContain('unknown installation');
  });

  it('logs heartbeat failures at warn level', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'worker', stream });

    const failingStore = {
      ...store,
      touchReviewRun: vi.fn().mockRejectedValue(new Error('Connection reset')),
    } as unknown as MemoryStore;

    const stopHeartbeat = startRunHeartbeat(failingStore, workspaceId, 'run-fail-hb', {
      intervalMs: 10,
      logger,
    });

    await new Promise((r) => setTimeout(r, 35));
    stopHeartbeat();

    const warnLines = lines.filter((l) => l.event === 'run.heartbeat_failed' && l.level === 40);
    expect(warnLines.length).toBeGreaterThan(0);
    expect(warnLines[0]?.runId).toBe('run-fail-hb');
    expect(warnLines[0]?.workspaceId).toBe(workspaceId);
  });
});

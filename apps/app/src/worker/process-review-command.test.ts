import { describe, expect, it, vi } from 'vitest';
import { Secret, type ReviewModel } from '@mergepilot/engine';
import type { GitHubClient, GitHubIssueComment, GitHubReview } from '@mergepilot/github';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewCommandJob, ReviewJob } from '../core/types.js';
import { processReviewCommandJob } from './process-review-command.js';
import { processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';

const silentLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as import('pino').Logger;
const PUBLISHER = 'mergepilot[bot]';
const PATCH = '@@ -1,1 +1,2 @@\n line\n+added';

interface Options {
  permission?: string;
  prState?: { state?: string; merged?: boolean };
  labels?: string[];
}

async function setup(options: Options = {}) {
  const store = new MemoryStore();
  await store.upsertInstallation({
    id: 7, workspaceId: 'ws-1', accountLogin: 'acme', accountType: 'Organization', repositorySelection: 'all', suspended: false,
  });
  await store.saveSettings({ workspaceId: 'ws-1', provider: 'anthropic', model: 'm', language: 'en', monthlyBudgetUsd: null });

  const issueComments: GitHubIssueComment[] = [];
  const reviews: GitHubReview[] = [];
  const client: GitHubClient = {
    listPullRequestFilesPage: async ({ page }) =>
      page === 1 ? [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: PATCH }] : [],
    getPullRequest: async () => ({
      head: { sha: 'head-1' }, base: { sha: 'base-1' }, labels: (options.labels ?? []).map((name) => ({ name })),
      ...(options.prState ?? { state: 'open' }),
    }) as unknown as Awaited<ReturnType<GitHubClient['getPullRequest']>>,
    listReviewsPage: async ({ page }) => (page === 1 ? reviews : []),
    createReview: vi.fn(async ({ body }: { body?: string }) => {
      reviews.push({ id: 100 + reviews.length, body: body ?? '', user: { login: PUBLISHER } });
      return { id: 100 + reviews.length };
    }),
    getFileContent: async () => null,
    compareCommits: async () => null,
    listIssueCommentsPage: async () => issueComments,
    createIssueComment: async ({ body }) => {
      issueComments.push({ id: issueComments.length + 1, body, user: { login: PUBLISHER } });
      return { id: issueComments.length };
    },
    getCollaboratorPermission: async () => ({ permission: options.permission ?? 'write' }),
  };
  const model: ReviewModel = {
    label: 'anthropic:m',
    generate: vi.fn(async () => ({ text: JSON.stringify({ summary: 'Looked again.', findings: [] }), finishReason: 'stop' as const })),
  };
  const deps: ProcessReviewDeps = {
    store,
    credentials: { resolve: vi.fn(async () => new Secret('sk-test')) },
    githubAppFactory: async () => ({ client, publisherLogin: PUBLISHER }),
    createModelForProvider: vi.fn(async () => model),
    logger: silentLogger,
  };
  const command: ReviewCommandJob = {
    kind: 'review_command', deliveryId: 'c-1', installationId: 7, repoFullName: 'acme/repo', pullNumber: 12,
    command: 'review', commenterLogin: 'dev', language: 'en',
  };
  return { store, client, deps, command, issueComments, model };
}

const push: ReviewJob = { deliveryId: 'p-1', installationId: 7, repoFullName: 'acme/repo', pullNumber: 12, headSha: 'head-1', baseSha: 'base-1' };

/** The bot reviews head-1 once, as on a normal push, leaving its real review marker. */
async function reviewedOnce(options: Options = {}) {
  const env = await setup(options);
  expect((await processReviewJob(push, env.deps)).status).toBe('completed');
  vi.mocked(env.model.generate).mockClear();
  vi.mocked(env.client.createReview).mockClear();
  return env;
}

describe('processReviewCommandJob — @mergepilot review', () => {
  it('reviews again a head the bot already reviewed, even on a paused PR, with no extra reply', async () => {
    const labels: string[] = [];
    const env = await reviewedOnce({ labels });
    labels.push('mergepilot:paused');

    expect(await processReviewCommandJob(env.command, env.deps)).toBe('reviewed');

    expect(env.model.generate).toHaveBeenCalledTimes(1);
    expect(env.client.createReview).toHaveBeenCalledTimes(1);
    expect(env.issueComments).toEqual([]);
  });

  it.each([
    { name: 'a commenter without write access', options: { permission: 'read' }, reason: 'unauthorized', text: 'write access' },
    { name: 'a merged PR', options: { prState: { state: 'closed', merged: true } }, reason: 'closed', text: 'closed' },
  ])('refuses $name with one reply and no review', async ({ options, reason, text }) => {
    const env = await setup(options);

    expect(await processReviewCommandJob(env.command, env.deps)).toBe(reason);

    expect(env.model.generate).not.toHaveBeenCalled();
    expect(env.client.createReview).not.toHaveBeenCalled();
    expect(env.issueComments).toHaveLength(1);
    expect(env.issueComments[0]?.body).toContain(text);
  });

  it('refuses while a review of this head is already running', async () => {
    const env = await setup();
    await env.store.createReviewRun({
      workspaceId: 'ws-1', installationId: 7, repoFullName: 'acme/repo', pullNumber: 12, headSha: 'head-1',
      status: 'running', jobId: 'other',
    });

    expect(await processReviewCommandJob(env.command, env.deps)).toBe('running');
    expect(env.model.generate).not.toHaveBeenCalled();
    expect(env.issueComments[0]?.body).toContain('already running');
  });

  it('answers "running" when a push claimed the head between the check and the review', async () => {
    const env = await setup();
    // The push's run appears right after the active-run check said there was none.
    const check = env.store.findActiveReviewRun.bind(env.store);
    vi.spyOn(env.store, 'findActiveReviewRun').mockImplementationOnce(async (...args) => {
      const active = await check(...args);
      await env.store.createReviewRun({
        workspaceId: 'ws-1', installationId: 7, repoFullName: 'acme/repo', pullNumber: 12, headSha: 'head-1',
        status: 'running', jobId: 'push-job',
      });
      return active;
    });

    expect(await processReviewCommandJob(env.command, env.deps)).toBe('running');

    expect(env.model.generate).not.toHaveBeenCalled();
    expect(env.client.createReview).not.toHaveBeenCalled();
    expect(env.issueComments).toHaveLength(1);
    expect(env.issueComments[0]?.body).toContain('already running');
  });

  it('reports a review that ran but failed, instead of calling it reviewed', async () => {
    const env = await setup();
    vi.mocked(env.model.generate).mockResolvedValue({ text: 'not json', finishReason: 'stop' });

    expect(await processReviewCommandJob(env.command, env.deps)).toBe('review_failed');
    expect(env.issueComments).toEqual([]);
  });

  it('still answers "running" when the refusal reply cannot be posted, instead of failing the job', async () => {
    const env = await setup();
    const check = env.store.findActiveReviewRun.bind(env.store);
    vi.spyOn(env.store, 'findActiveReviewRun').mockImplementationOnce(async (...args) => {
      const active = await check(...args);
      await env.store.createReviewRun({
        workspaceId: 'ws-1', installationId: 7, repoFullName: 'acme/repo', pullNumber: 12, headSha: 'head-1',
        status: 'running', jobId: 'push-job',
      });
      return active;
    });
    env.client.createIssueComment = vi.fn(async () => { throw new Error('GitHub 502'); });

    await expect(processReviewCommandJob(env.command, env.deps)).resolves.toBe('running');
  });
});

describe('processReviewJob — a push with nothing new to review', () => {
  it('says so once per head, pointing to @mergepilot review, without calling the model', async () => {
    const env = await reviewedOnce();

    const result = await processReviewJob({ ...push, deliveryId: 'p-2' }, env.deps);
    await processReviewJob({ ...push, deliveryId: 'p-3' }, env.deps);

    expect(result).toMatchObject({ status: 'skipped', detail: 'no new changes since the last review' });
    expect(env.model.generate).not.toHaveBeenCalled();
    expect(env.issueComments).toHaveLength(1);
    expect(env.issueComments[0]?.body).toContain('`@mergepilot review`');
    expect(env.issueComments[0]?.body).toContain('<!-- mergepilot:nothing-new head=head-1 -->');
  });
  const httpError = (status: number, headers: Record<string, string> = {}) =>
    Object.assign(new Error(`GitHub ${status}`), { status, response: { headers } });

  it.each([
    { name: 'a transient 502 on an unauthorized refusal', options: { permission: 'read' }, status: 502, retried: true },
    { name: 'a permanent 403 (locked conversation)', options: { permission: 'read' }, status: 403, retried: false },
    { name: 'a 403 secondary rate limit (retry-after)', options: { permission: 'read' }, status: 403, headers: { 'retry-after': '60' }, retried: true },
    { name: 'a 403 primary rate limit (no requests left)', options: { permission: 'read' }, status: 403, headers: { 'x-ratelimit-remaining': '0' }, retried: true },
    { name: 'a transient 502 on a "running" refusal, whose outcome a retry could change', options: {}, status: 502, retried: false },
  ] as Array<{ name: string; options: { permission?: string }; status: number; headers?: Record<string, string>; retried: boolean }>)(
    'fails the job for a retry only on $name', async ({ options, status, headers, retried }) => {
    const env = await setup(options);
    if (!('permission' in options)) {
      await env.store.createReviewRun({
        workspaceId: 'ws-1', installationId: 7, repoFullName: 'acme/repo', pullNumber: 12, headSha: 'head-1',
        status: 'running', jobId: 'other',
      });
    }
    env.client.createIssueComment = vi.fn(async () => { throw httpError(status, headers); });

    const run = processReviewCommandJob(env.command, env.deps);
    if (retried) await expect(run).rejects.toThrow(`GitHub ${status}`);
    else await expect(run).resolves.toBe('permission' in options ? 'unauthorized' : 'running');
    expect(env.model.generate).not.toHaveBeenCalled();
  });

  it('does not repeat the refusal when the queue retries the same request', async () => {
    const env = await setup({ permission: 'read' });

    await processReviewCommandJob(env.command, env.deps);
    await processReviewCommandJob(env.command, env.deps);

    expect(env.issueComments).toHaveLength(1);
  });
});

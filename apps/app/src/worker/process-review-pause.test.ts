import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@mergepilot/engine';
import type { GitHubClient, GitHubIssueComment } from '@mergepilot/github';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewJob } from '../core/types.js';
import { processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';
import { guardWritesForWorkspace } from './workspace-guard.js';

const silentLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as import('pino').Logger;

async function setup(labels: string[]) {
  const store = new MemoryStore();
  await store.upsertInstallation({
    id: 7,
    workspaceId: 'ws-1',
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspended: false,
  });
  await store.saveSettings({ workspaceId: 'ws-1', provider: 'anthropic', model: 'm', language: 'ar', monthlyBudgetUsd: null });
  const issueComments: GitHubIssueComment[] = [];
  const client: GitHubClient = {
    listPullRequestFilesPage: async () => [],
    getPullRequest: async () => ({ head: { sha: 'head-1' }, labels: labels.map((name) => ({ name })) }),
    listReviewsPage: async () => [],
    createReview: vi.fn(async () => ({ id: 1 })),
    getFileContent: async () => null,
    compareCommits: async () => null,
    listIssueCommentsPage: async () => issueComments,
    createIssueComment: async ({ body }) => {
      issueComments.push({ id: issueComments.length + 1, body, user: { login: 'mergepilot[bot]' } });
      return { id: issueComments.length };
    },
  };
  const credentials = { resolve: vi.fn(async () => new Secret('sk-test')) };
  const createModelForProvider = vi.fn();
  const deps: ProcessReviewDeps = {
    store,
    credentials,
    githubAppFactory: async () => ({ client, publisherLogin: 'mergepilot[bot]' }),
    createModelForProvider,
    logger: silentLogger,
  };
  const job: ReviewJob = {
    deliveryId: 'd-1',
    installationId: 7,
    repoFullName: 'acme/repo',
    pullNumber: 12,
    headSha: 'head-1',
    baseSha: 'base-1',
  };
  return { store, client, deps, job, issueComments, credentials, createModelForProvider };
}

describe('processReviewJob — paused PR (SaaS)', () => {
  it('skips a labelled PR before any credential or model, and posts the notice once', async () => {
    const env = await setup(['mergepilot:paused']);

    const first = await processReviewJob(env.job, env.deps);
    expect(first).toEqual({ status: 'skipped', detail: 'automatic reviews are paused on this PR' });
    expect(env.credentials.resolve).not.toHaveBeenCalled();
    expect(env.createModelForProvider).not.toHaveBeenCalled();
    expect(env.client.createReview).not.toHaveBeenCalled();
    expect(env.issueComments).toHaveLength(1);
    expect(env.issueComments[0]?.body).toContain('<!-- mergepilot:pause-notice -->');
    expect(env.issueComments[0]?.body).toContain('@mergepilot استئناف');

    const runs = await env.store.listReviewRuns('ws-1', 10);
    expect(runs[0]?.status).toBe('skipped');

    await processReviewJob({ ...env.job, deliveryId: 'd-2', headSha: 'head-1' }, env.deps);
    expect(env.issueComments).toHaveLength(1);
  });
});

describe('guardWritesForWorkspace', () => {
  it('keeps the optional comment, label and permission methods (reads pass, writes are guarded)', async () => {
    const env = await setup([]);
    const full: GitHubClient = {
      ...env.client,
      listReviewCommentsPage: async () => [],
      getCollaboratorPermission: async () => ({ permission: 'write' }),
      addLabels: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };
    const guarded = guardWritesForWorkspace(full, env.store, 7, 'ws-1');
    for (const method of [
      'listReviewCommentsPage',
      'listIssueCommentsPage',
      'getCollaboratorPermission',
      'createIssueComment',
      'addLabels',
      'removeLabel',
    ] as const) {
      expect(typeof guarded[method]).toBe('function');
    }

    await env.store.deleteInstallation(7);
    await expect(
      guarded.addLabels?.({ owner: 'acme', repo: 'repo', issue_number: 12, labels: ['x'] }),
    ).rejects.toThrow();
    expect(full.addLabels).not.toHaveBeenCalled();
    await expect(guarded.listReviewCommentsPage?.({ owner: 'acme', repo: 'repo', pull_number: 12 })).resolves.toEqual([]);
  });
});

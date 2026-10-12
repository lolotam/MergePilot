import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '@mergepilot/github';
import { MemoryStore } from '../core/memory-store.js';
import type { PauseCommandJob } from '../core/types.js';
import { processPauseCommandJob } from './process-pause-command.js';

const silentLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as import('pino').Logger;

async function setup(opts: { permission?: string; installation?: 'linked' | 'missing' | 'suspended' } = {}) {
  const store = new MemoryStore();
  if (opts.installation !== 'missing') {
    await store.upsertInstallation({
      id: 7,
      workspaceId: 'ws-1',
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: opts.installation === 'suspended',
    });
  }
  const added: string[] = [];
  const removed: string[] = [];
  const replies: string[] = [];
  const permissionLookups: string[] = [];
  const client: GitHubClient = {
    listPullRequestFilesPage: async () => [],
    getPullRequest: async () => ({ head: { sha: 'h' } }),
    listReviewsPage: async () => [],
    createReview: async () => ({ id: 1 }),
    getFileContent: async () => null,
    compareCommits: async () => null,
    getCollaboratorPermission: async ({ username }) => {
      permissionLookups.push(username);
      return { permission: opts.permission ?? 'write' };
    },
    addLabels: async ({ labels }) => {
      added.push(...labels);
    },
    removeLabel: async ({ name }) => {
      removed.push(name);
    },
    createIssueComment: async ({ body }) => {
      replies.push(body);
      return { id: replies.length };
    },
  };
  const githubAppFactory = vi.fn(async () => ({ client, publisherLogin: 'mergepilot[bot]' }));
  const deps = { store, githubAppFactory, logger: silentLogger };
  const job = (overrides: Partial<PauseCommandJob> = {}): PauseCommandJob => ({
    kind: 'pause_command',
    deliveryId: 'd-1',
    installationId: 7,
    repoFullName: 'acme/repo',
    pullNumber: 12,
    command: 'pause',
    commenterLogin: 'alice',
    language: 'en',
    ...overrides,
  });
  return { deps, job, added, removed, replies, permissionLookups, githubAppFactory };
}

describe('processPauseCommandJob', () => {
  it('pauses for a commenter with write access: adds the label and replies once', async () => {
    const env = await setup({ permission: 'write' });
    expect(await processPauseCommandJob(env.job(), env.deps)).toBe('paused');
    expect(env.permissionLookups).toEqual(['alice']);
    expect(env.added).toEqual(['mergepilot:paused']);
    expect(env.replies).toHaveLength(1);
    expect(env.replies[0]).toContain('<!-- mergepilot:state paused -->');
  });

  it('resumes for an admin: removes the label and replies once', async () => {
    const env = await setup({ permission: 'admin' });
    expect(await processPauseCommandJob(env.job({ command: 'resume' }), env.deps)).toBe('active');
    expect(env.removed).toEqual(['mergepilot:paused']);
    expect(env.added).toHaveLength(0);
    expect(env.replies[0]).toContain('<!-- mergepilot:state active -->');
  });

  it('replies in Arabic for the Arabic aliases', async () => {
    const env = await setup();
    await processPauseCommandJob(env.job({ language: 'ar' }), env.deps);
    await processPauseCommandJob(env.job({ command: 'resume', language: 'ar' }), env.deps);
    expect(env.replies[0]).toContain('تم إيقاف المراجعات التلقائية');
    expect(env.replies[1]).toContain('تم استئناف المراجعات التلقائية');
  });

  it('leaves the PR unchanged for a read-only commenter and replies politely', async () => {
    const env = await setup({ permission: 'read' });
    expect(await processPauseCommandJob(env.job(), env.deps)).toBe('unauthorized');
    expect(env.added).toHaveLength(0);
    expect(env.removed).toHaveLength(0);
    expect(env.replies).toHaveLength(1);
    expect(env.replies[0]).toContain('you need write access');
    expect(env.replies[0]).not.toContain('mergepilot:state');
  });

  it('skips without any GitHub call for an unknown or suspended installation', async () => {
    for (const installation of ['missing', 'suspended'] as const) {
      const env = await setup({ installation });
      expect(await processPauseCommandJob(env.job(), env.deps)).toBe('skipped');
      expect(env.githubAppFactory).not.toHaveBeenCalled();
    }
  });
});

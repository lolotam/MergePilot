import { describe, expect, it } from 'vitest';
import type { GitHubClient, GitHubIssueComment } from '@mergepilot/github';
import { runIssueComment } from './issue-comment.js';
import type { ActionDeps } from './deps.js';

describe('runIssueComment', () => {
  function createPayload(opts: {
    isPr?: boolean;
    body?: string;
    login?: string;
    association?: string;
    userType?: string;
    action?: string;
  } = {}) {
    return {
      action: opts.action ?? 'created',
      issue: {
        number: 42,
        ...(opts.isPr ?? true ? { pull_request: {} } : {}),
      },
      comment: {
        body: opts.body ?? '@mergepilot pause',
        user: { login: opts.login ?? 'alice', ...(opts.userType ? { type: opts.userType } : {}) },
        author_association: opts.association ?? 'MEMBER',
      },
    };
  }

  function setup(opts: {
    eventName?: string;
    payload?: object;
    hasToken?: boolean;
    hasRepo?: boolean;
    existingLabels?: string[];
    permission?: string;
  } = {}) {
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
    };

    const payload = opts.payload ?? createPayload();
    const eventJson = JSON.stringify(payload);

    const env: Record<string, string | undefined> = {
      GITHUB_EVENT_NAME: opts.eventName ?? 'issue_comment',
      GITHUB_EVENT_PATH: '/fake/event.json',
      GITHUB_REPOSITORY: opts.hasRepo === false ? undefined : 'acme/repo',
      GITHUB_TOKEN: opts.hasToken === false ? undefined : 'gh-token-test',
    };

    const addedLabels: string[] = [];
    const removedLabels: string[] = [];
    const createdComments: string[] = [];

    const fakeClient: Partial<GitHubClient> = {
      async listIssueCommentsPage(): Promise<GitHubIssueComment[]> {
        return [];
      },
      async createIssueComment(params) {
        createdComments.push(params.body);
        return { id: 101, body: params.body };
      },
      async addLabels(params) {
        addedLabels.push(...params.labels);
      },
      async removeLabel(params) {
        removedLabels.push(params.name);
      },
      async getCollaboratorPermission() {
        return { permission: opts.permission ?? 'write' };
      },
    };

    const deps: ActionDeps = {
      env,
      readFile: async (p: string) => {
        if (p === '/fake/event.json') return eventJson;
        throw new Error(`Not found: ${p}`);
      },
      createClient: () => fakeClient as GitHubClient,
      log,
    };

    return { deps, logs, addedLabels, removedLabels, createdComments };
  }

  it('skips when event name is not issue_comment', async () => {
    const { deps, logs } = setup({ eventName: 'push' });
    await runIssueComment(deps);
    expect(logs.some((l) => l.includes('not issue_comment'))).toBe(true);
  });

  it('skips when comment is not on a pull request', async () => {
    const { deps, logs } = setup({
      payload: createPayload({ isPr: false }),
    });
    await runIssueComment(deps);
    expect(logs.some((l) => l.includes('not on a pull request'))).toBe(true);
  });

  it('skips when comment has no @mergepilot pause/resume command', async () => {
    const { deps, logs, addedLabels } = setup({
      payload: createPayload({ body: 'Just a regular comment' }),
    });
    await runIssueComment(deps);
    expect(logs.some((l) => l.includes('does not contain @mergepilot'))).toBe(true);
    expect(addedLabels).toHaveLength(0);
  });

  it('executes pause command when authorized', async () => {
    const { deps, addedLabels, createdComments, logs } = setup({
      payload: createPayload({ body: '@mergepilot pause', association: 'COLLABORATOR' }),
    });
    await runIssueComment(deps);
    expect(addedLabels).toContain('mergepilot:paused');
    expect(createdComments.some((c) => c.includes('Automatic reviews paused'))).toBe(true);
    expect(logs.some((l) => l.includes('paused'))).toBe(true);
  });

  it('executes Arabic pause command @mergepilot إيقاف', async () => {
    const { deps, addedLabels, createdComments } = setup({
      payload: createPayload({ body: 'من فضلك @mergepilot إيقاف الآن', association: 'MEMBER' }),
    });
    await runIssueComment(deps);
    expect(addedLabels).toContain('mergepilot:paused');
    expect(createdComments.some((c) => c.includes('تم إيقاف المراجعات التلقائية'))).toBe(true);
  });

  it('executes resume command when authorized', async () => {
    const { deps, removedLabels, createdComments, logs } = setup({
      payload: createPayload({ body: '@mergepilot resume', association: 'OWNER' }),
    });
    await runIssueComment(deps);
    expect(removedLabels).toContain('mergepilot:paused');
    expect(createdComments.some((c) => c.includes('Automatic reviews resumed'))).toBe(true);
    expect(logs.some((l) => l.includes('active'))).toBe(true);
  });

  it('executes Arabic resume command @mergepilot استئناف', async () => {
    const { deps, removedLabels, createdComments } = setup({
      payload: createPayload({ body: '@mergepilot استئناف', association: 'MEMBER' }),
    });
    await runIssueComment(deps);
    expect(removedLabels).toContain('mergepilot:paused');
    expect(createdComments.some((c) => c.includes('تم استئناف المراجعات التلقائية'))).toBe(true);
  });

  it('rejects command when user is unauthorized', async () => {
    const { deps, addedLabels, createdComments, logs } = setup({
      payload: createPayload({ body: '@mergepilot pause', association: 'NONE', login: 'stranger' }),
      permission: 'read',
    });
    await runIssueComment(deps);
    expect(addedLabels).toHaveLength(0);
    expect(createdComments.some((c) => c.includes('you need write access'))).toBe(true);
    expect(logs.some((l) => l.includes('unauthorized'))).toBe(true);
  });

  it('denies a MEMBER whose repository permission is only read (no label change)', async () => {
    const { deps, addedLabels, createdComments } = setup({
      payload: createPayload({ body: '@mergepilot pause', association: 'MEMBER' }),
      permission: 'read',
    });
    await runIssueComment(deps);
    expect(addedLabels).toHaveLength(0);
    expect(createdComments.some((c) => c.includes('you need write access'))).toBe(true);
  });

  it('ignores commands posted by bots (including its own replies)', async () => {
    const { deps, logs, addedLabels, createdComments } = setup({
      payload: createPayload({ body: '@mergepilot pause', login: 'github-actions[bot]', userType: 'Bot' }),
    });
    await runIssueComment(deps);
    expect(logs.some((l) => l.includes('posted by a bot'))).toBe(true);
    expect(addedLabels).toHaveLength(0);
    expect(createdComments).toHaveLength(0);
  });

  it('ignores edited or deleted comments', async () => {
    const { deps, logs, addedLabels } = setup({ payload: createPayload({ action: 'edited' }) });
    await runIssueComment(deps);
    expect(logs.some((l) => l.includes('is not created'))).toBe(true);
    expect(addedLabels).toHaveLength(0);
  });

  it('throws error when GITHUB_REPOSITORY is missing', async () => {
    const { deps } = setup({ hasRepo: false });
    await expect(runIssueComment(deps)).rejects.toThrow('GITHUB_REPOSITORY is not set');
  });

  it('throws error when GITHUB_TOKEN is missing', async () => {
    const { deps } = setup({ hasToken: false });
    await expect(runIssueComment(deps)).rejects.toThrow('GITHUB_TOKEN');
  });
});

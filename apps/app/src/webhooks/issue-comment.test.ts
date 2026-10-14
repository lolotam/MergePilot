import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import type { CommandJob, ReviewJob, ReviewQueue } from '../core/types.js';
import { webhookOutcomeFields, webhookPayloadFields } from '../server/webhook-log.js';
import { handleWebhook } from './handle.js';

class FakeQueue implements ReviewQueue {
  readonly jobs: ReviewJob[] = [];
  readonly commands: CommandJob[] = [];
  async enqueue(job: ReviewJob): Promise<void> {
    this.jobs.push(job);
  }
  async enqueueCommand(job: CommandJob): Promise<void> {
    this.commands.push(job);
  }
}

const commentPayload = (overrides: {
  action?: string;
  body?: string;
  isPr?: boolean;
  login?: string;
  userType?: string;
} = {}) => ({
  action: overrides.action ?? 'created',
  installation: { id: 101 },
  repository: { full_name: 'test-org/repo-1' },
  issue: { number: 42, ...((overrides.isPr ?? true) ? { pull_request: { url: 'x' } } : {}) },
  comment: {
    body: overrides.body ?? '@mergepilot pause',
    user: { login: overrides.login ?? 'alice', type: overrides.userType ?? 'User' },
  },
});

describe('handleWebhook — issue_comment pause/resume commands', () => {
  let store: MemoryStore;
  let queue: FakeQueue;
  let delivery = 0;

  const send = (payload: unknown, q: ReviewQueue = queue) =>
    handleWebhook({ event: 'issue_comment', deliveryId: `d-${++delivery}`, payload }, { store, queue: q });

  beforeEach(async () => {
    store = new MemoryStore();
    queue = new FakeQueue();
    await store.upsertInstallation({
      id: 101,
      workspaceId: 'ws-1',
      accountLogin: 'test-org',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });
  });

  it.each([
    { body: '@mergepilot review', language: 'en' },
    { body: 'بعد الـ merge: @mergepilot مراجعة', language: 'ar' },
  ])('queues a review command for "$body" and logs it as queued', async ({ body, language }) => {
    const result = await send(commentPayload({ body }));

    expect(result.status).toBe('command_queued');
    expect(queue.commands).toEqual([
      {
        kind: 'review_command',
        deliveryId: `d-${delivery}`,
        installationId: 101,
        repoFullName: 'test-org/repo-1',
        pullNumber: 42,
        command: 'review',
        commenterLogin: 'alice',
        language,
      },
    ]);
    expect(webhookOutcomeFields(result)).toEqual({ outcome: 'queued', command: 'review' });
  });

  it('ignores a quoted `@mergepilot review` (as in MergePilot\'s own notes) and look-alike words', async () => {
    for (const body of ['comment `@mergepilot review` to review again', '@mergepilot reviewer please']) {
      expect(await send(commentPayload({ body }))).toEqual({ status: 'ignored', reason: 'not_a_command' });
    }
    expect(queue.commands).toHaveLength(0);
  });

  it('queues a pause command on a PR and logs it as queued', async () => {
    const payload = commentPayload({ body: 'Hold on please: @mergepilot pause' });
    const result = await send(payload);

    expect(result.status).toBe('command_queued');
    expect(queue.commands).toEqual([
      {
        kind: 'pause_command',
        deliveryId: `d-${delivery}`,
        installationId: 101,
        repoFullName: 'test-org/repo-1',
        pullNumber: 42,
        command: 'pause',
        commenterLogin: 'alice',
        language: 'en',
      },
    ]);
    expect(queue.jobs).toHaveLength(0);
    expect(webhookOutcomeFields(result)).toEqual({ outcome: 'queued', command: 'pause' });
    expect(webhookPayloadFields(payload)).toEqual({ action: 'created', repo: 'test-org/repo-1', pr: 42 });
  });

  it('queues Arabic aliases with an Arabic reply language', async () => {
    await send(commentPayload({ body: '@mergepilot إيقاف' }));
    await send(commentPayload({ body: '@mergepilot استئناف' }));
    expect(queue.commands.map((c) => [c.command, c.language])).toEqual([
      ['pause', 'ar'],
      ['resume', 'ar'],
    ]);
  });

  it('ignores ordinary comments', async () => {
    const result = await send(commentPayload({ body: 'LGTM, thanks!' }));
    expect(result).toEqual({ status: 'ignored', reason: 'not_a_command' });
    expect(webhookOutcomeFields(result)).toEqual({ outcome: 'ignored', reason: 'not_a_command' });
    expect(queue.commands).toHaveLength(0);
  });

  it('ignores a command on a plain issue (not a pull request)', async () => {
    const payload = commentPayload({ isPr: false });
    const result = await send(payload);
    expect(result).toEqual({ status: 'ignored', reason: 'not_a_pull_request' });
    expect(webhookPayloadFields(payload).pr).toBeNull();
    expect(queue.commands).toHaveLength(0);
  });

  it('ignores edited comments and comments from bots', async () => {
    expect(await send(commentPayload({ action: 'edited' }))).toEqual({
      status: 'ignored',
      reason: 'issue_comment_not_created',
    });
    expect(await send(commentPayload({ login: 'mergepilot[bot]', userType: 'Bot' }))).toEqual({
      status: 'ignored',
      reason: 'bot_comment',
    });
    expect(queue.commands).toHaveLength(0);
  });

  it('ignores commands for unknown or suspended installations', async () => {
    await store.setInstallationSuspended(101, true);
    expect(await send(commentPayload())).toEqual({ status: 'ignored', reason: 'installation_suspended' });
    await store.deleteInstallation(101);
    expect(await send(commentPayload())).toEqual({
      status: 'ignored',
      reason: 'installation_not_found_or_pending',
    });
    expect(queue.commands).toHaveLength(0);
  });

  it('ignores the command when the queue cannot carry commands', async () => {
    const reviewOnly: ReviewQueue = { enqueue: async () => {} };
    expect(await send(commentPayload(), reviewOnly)).toEqual({
      status: 'ignored',
      reason: 'command_queue_unavailable',
    });
  });

  it('rejects an invalid payload', async () => {
    expect(await send({ action: 'created' })).toEqual({
      status: 'ignored',
      reason: 'invalid_issue_comment_payload',
    });
  });
});

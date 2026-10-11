import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import { handleWebhook } from './handle.js';

class FakeQueue implements ReviewQueue {
  readonly jobs: ReviewJob[] = [];
  async enqueue(job: ReviewJob): Promise<void> {
    this.jobs.push(job);
  }
}

describe('handleWebhook', () => {
  let store: MemoryStore;
  let queue: FakeQueue;
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    store = new MemoryStore();
    queue = new FakeQueue();
    vi.clearAllMocks();
  });

  const validInstallationPayload = {
    action: 'created',
    installation: {
      id: 101,
      account: {
        login: 'test-org',
        type: 'Organization',
      },
      repository_selection: 'selected',
    },
  };

  const validPrPayload = (overrides?: Record<string, unknown>) => ({
    action: 'opened',
    installation: { id: 101 },
    repository: { full_name: 'test-org/repo-1' },
    pull_request: {
      number: 42,
      draft: false,
      head: { sha: 'head-sha-123' },
      base: { sha: 'base-sha-456' },
      head_repo_is_fork: true,
      ...overrides,
    },
  });

  it('records delivery and returns duplicate when delivery was already seen', async () => {
    await store.recordDelivery('d-dup', 'pull_request');

    const result = await handleWebhook(
      { event: 'pull_request', deliveryId: 'd-dup', payload: validPrPayload() },
      { store, queue, log },
    );

    expect(result).toEqual({ status: 'duplicate' });
    expect(queue.jobs).toHaveLength(0);
  });

  describe('installation events', () => {
    it('installation created → upsertPendingInstallation', async () => {
      const result = await handleWebhook(
        { event: 'installation', deliveryId: 'd-1', payload: validInstallationPayload },
        { store, queue, log },
      );

      expect(result).toMatchObject({ status: 'installation_created', installationId: 101 });
      // In MemoryStore, pending installation is stored without workspaceId:
      const raw = store.installations.get(101);
      expect(raw).toBeDefined();
      expect(raw?.accountLogin).toBe('test-org');
      expect(raw?.accountType).toBe('Organization');
      expect((raw as { workspaceId?: string }).workspaceId).toBeUndefined();
      // getInstallation returns null because it is not linked yet:
      expect(await store.getInstallation(101)).toBeNull();
    });

    it('installation deleted → deleteInstallation', async () => {
      await store.upsertInstallation({
        id: 101,
        workspaceId: 'w-1',
        accountLogin: 'test-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const result = await handleWebhook(
        {
          event: 'installation',
          deliveryId: 'd-del',
          payload: { action: 'deleted', installation: { id: 101 } },
        },
        { store, queue, log },
      );

      expect(result).toMatchObject({ status: 'installation_deleted', installationId: 101 });
      expect(store.installations.get(101)).toBeUndefined();
    });

    it('installation suspend and unsuspend updates status', async () => {
      await store.upsertInstallation({
        id: 101,
        workspaceId: 'w-1',
        accountLogin: 'test-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const suspendRes = await handleWebhook(
        {
          event: 'installation',
          deliveryId: 'd-suspend',
          payload: { action: 'suspend', installation: { id: 101 } },
        },
        { store, queue, log },
      );
      expect(suspendRes).toMatchObject({ status: 'installation_suspended', installationId: 101 });
      expect((await store.getInstallation(101))?.suspended).toBe(true);

      const unsuspendRes = await handleWebhook(
        {
          event: 'installation',
          deliveryId: 'd-unsuspend',
          payload: { action: 'unsuspend', installation: { id: 101 } },
        },
        { store, queue, log },
      );
      expect(unsuspendRes).toMatchObject({ status: 'installation_unsuspended', installationId: 101 });
      expect((await store.getInstallation(101))?.suspended).toBe(false);
    });
  });

  describe('pull_request events', () => {
    beforeEach(async () => {
      await store.upsertInstallation({
        id: 101,
        workspaceId: 'w-1',
        accountLogin: 'test-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });
    });

    it('enqueues review job on PR opened with linked installation', async () => {
      const result = await handleWebhook(
        { event: 'pull_request', deliveryId: 'd-pr-1', payload: validPrPayload() },
        { store, queue, log },
      );

      expect(result.status).toBe('enqueued');
      expect(queue.jobs).toEqual([
        {
          deliveryId: 'd-pr-1',
          installationId: 101,
          repoFullName: 'test-org/repo-1',
          pullNumber: 42,
          headSha: 'head-sha-123',
          baseSha: 'base-sha-456',
        },
      ]);
    });

    it('enqueues review job for synchronize, reopened, ready_for_review actions', async () => {
      for (const action of ['synchronize', 'reopened', 'ready_for_review']) {
        const deliveryId = `d-action-${action}`;
        const result = await handleWebhook(
          {
            event: 'pull_request',
            deliveryId,
            payload: { ...validPrPayload(), action },
          },
          { store, queue, log },
        );
        expect(result.status).toBe('enqueued');
      }
      expect(queue.jobs).toHaveLength(3);
    });

    it('enqueues job even if pull request is from a fork', async () => {
      const result = await handleWebhook(
        {
          event: 'pull_request',
          deliveryId: 'd-fork',
          payload: {
            ...validPrPayload(),
            pull_request: {
              number: 99,
              draft: false,
              head: { sha: 'fork-sha' },
              base: { sha: 'base-sha' },
            },
          },
        },
        { store, queue, log },
      );

      expect(result.status).toBe('enqueued');
      expect(queue.jobs[0].headSha).toBe('fork-sha');
    });

    it('skips draft pull requests', async () => {
      const result = await handleWebhook(
        {
          event: 'pull_request',
          deliveryId: 'd-draft',
          payload: validPrPayload({ draft: true }),
        },
        { store, queue, log },
      );

      expect(result.status).toBe('ignored');
      expect(queue.jobs).toHaveLength(0);
    });

    it('skips when installation is unknown', async () => {
      const result = await handleWebhook(
        {
          event: 'pull_request',
          deliveryId: 'd-unk',
          payload: { ...validPrPayload(), installation: { id: 999 } },
        },
        { store, queue, log },
      );

      expect(result.status).toBe('ignored');
      expect(queue.jobs).toHaveLength(0);
    });

    it('skips when installation is pending (not linked to workspace)', async () => {
      await store.upsertPendingInstallation({
        id: 202,
        accountLogin: 'pending-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const result = await handleWebhook(
        {
          event: 'pull_request',
          deliveryId: 'd-pend',
          payload: { ...validPrPayload(), installation: { id: 202 } },
        },
        { store, queue, log },
      );

      expect(result.status).toBe('ignored');
      expect(queue.jobs).toHaveLength(0);
    });

    it('skips when installation is suspended', async () => {
      await store.setInstallationSuspended(101, true);

      const result = await handleWebhook(
        {
          event: 'pull_request',
          deliveryId: 'd-susp',
          payload: validPrPayload(),
        },
        { store, queue, log },
      );

      expect(result.status).toBe('ignored');
      expect(queue.jobs).toHaveLength(0);
    });

    it('ignores unsupported PR actions like closed or labeled', async () => {
      const result = await handleWebhook(
        {
          event: 'pull_request',
          deliveryId: 'd-closed',
          payload: { ...validPrPayload(), action: 'closed' },
        },
        { store, queue, log },
      );

      expect(result.status).toBe('ignored');
      expect(queue.jobs).toHaveLength(0);
    });
  });

  describe('unknown events and invalid payloads', () => {
    it('returns ignored for non-handled event types like push or issues', async () => {
      const result = await handleWebhook(
        { event: 'push', deliveryId: 'd-push', payload: { ref: 'refs/heads/main' } },
        { store, queue, log },
      );

      expect(result.status).toBe('ignored');
      expect(queue.jobs).toHaveLength(0);
    });

    it('never throws on unknown or malformed payload shapes', async () => {
      const invalidPayloads = [null, undefined, '', 123, {}, { foo: 'bar' }, { action: 123 }];

      for (const [idx, payload] of invalidPayloads.entries()) {
        const result = await handleWebhook(
          { event: 'pull_request', deliveryId: `d-invalid-${idx}`, payload },
          { store, queue, log },
        );
        expect(result.status).toBe('ignored');
      }

      for (const [idx, payload] of invalidPayloads.entries()) {
        const result = await handleWebhook(
          { event: 'installation', deliveryId: `d-invalid-inst-${idx}`, payload },
          { store, queue, log },
        );
        expect(result.status).toBe('ignored');
      }
    });
  });
});

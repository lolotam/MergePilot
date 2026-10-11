import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../core/config.js';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import { createServer } from './create-server.js';

class FakeQueue implements ReviewQueue {
  readonly jobs: ReviewJob[] = [];
  async enqueue(job: ReviewJob): Promise<void> {
    this.jobs.push(job);
  }
}

describe('createServer', () => {
  const secret = 'webhook-test-secret-123';
  const mockConfig: AppConfig = {
    baseUrl: 'https://test.mergepilot.com',
    port: 3000,
    databaseUrl: 'memory:',
    redisUrl: 'redis://localhost:6379',
    masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    github: {
      appId: '12345',
      privateKey: 'fake-private-key',
      webhookSecret: secret,
      clientId: 'gh-client-id',
      clientSecret: 'gh-client-secret',
    },
    google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' },
    authSecret: 'better-auth-secret-key',
  };

  let store: MemoryStore;
  let queue: FakeQueue;

  beforeEach(() => {
    store = new MemoryStore();
    queue = new FakeQueue();
  });

  function sign(payload: string | Buffer): string {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    return `sha256=${createHmac('sha256', secret).update(buf).digest('hex')}`;
  }

  function postWebhook(
    app: FastifyInstance,
    opts: { event?: string; deliveryId?: string; signature?: string; payload: string },
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.event) headers['x-github-event'] = opts.event;
    if (opts.deliveryId) headers['x-github-delivery'] = opts.deliveryId;
    if (opts.signature) headers['x-hub-signature-256'] = opts.signature;
    return app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: opts.payload });
  }

  it('rejects a signed webhook without X-GitHub-Delivery so later deliveries are not deduped away', async () => {
    const app = createServer({ config: mockConfig, store, queue, log: false });
    const payload = JSON.stringify({ zen: 'hi' });
    const res = await postWebhook(app, { event: 'ping', signature: sign(payload), payload });
    expect(res.statusCode).toBe(400);
    expect(store.deliveries.size).toBe(0);
  });

  it('limits non-webhook routes to 1 MB bodies', async () => {
    const app = createServer({
      config: mockConfig,
      store,
      queue,
      log: false,
      extraRoutes: (instance) => {
        instance.post('/echo', async () => ({ ok: true }));
      },
    });
    const big = JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) });
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: big });
    expect(res.statusCode).toBe(413);
  });

  describe('POST /webhooks/github signature verification', () => {
    it('bad signature → 401 and nothing stored', async () => {
      const app = createServer({ config: mockConfig, store, queue, log: false });
      const res = await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-bad-sig',
        signature: 'sha256=bad1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        payload: JSON.stringify({ action: 'opened' }),
      });
      expect(res.statusCode).toBe(401);
      expect(store.deliveries.has('del-bad-sig')).toBe(false);
    });

    it('missing signature → 401 and nothing stored', async () => {
      const app = createServer({ config: mockConfig, store, queue, log: false });
      const res = await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-missing-sig',
        payload: JSON.stringify({ action: 'opened' }),
      });
      expect(res.statusCode).toBe(401);
      expect(store.deliveries.has('del-missing-sig')).toBe(false);
    });

    it('raw-body signature computed over exact bytes (whitespace-sensitive)', async () => {
      const app = createServer({ config: mockConfig, store, queue, log: false });
      const originalPayload = '{"action":"opened","key":"value"}';
      const modifiedWhitespacePayload = '{\n  "action": "opened",\n  "key": "value"\n}';

      const res = await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-ws-test',
        signature: sign(originalPayload),
        payload: modifiedWhitespacePayload,
      });
      expect(res.statusCode).toBe(401);
      expect(store.deliveries.has('del-ws-test')).toBe(false);
    });

    it('valid signature → 202', async () => {
      const app = createServer({ config: mockConfig, store, queue, log: false });
      const payload = JSON.stringify({ action: 'opened' });
      const res = await postWebhook(app, {
        event: 'unknown_event',
        deliveryId: 'del-valid',
        signature: sign(payload),
        payload,
      });
      expect(res.statusCode).toBe(202);
      expect(store.deliveries.has('del-valid')).toBe(true);
    });
  });

  describe('Webhook handling scenarios', () => {
    it('duplicate delivery → no second enqueue', async () => {
      await store.upsertInstallation({
        id: 50,
        workspaceId: 'ws-50',
        accountLogin: 'test-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const app = createServer({ config: mockConfig, store, queue, log: false });
      const payload = JSON.stringify({
        action: 'opened',
        installation: { id: 50 },
        repository: { full_name: 'test-org/repo' },
        pull_request: { number: 1, draft: false, head: { sha: 'head1' }, base: { sha: 'base1' } },
      });
      const signature = sign(payload);

      const res1 = await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-dup-1',
        signature,
        payload,
      });
      expect(res1.statusCode).toBe(202);
      expect(queue.jobs).toHaveLength(1);

      const res2 = await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-dup-1',
        signature,
        payload,
      });
      expect(res2.statusCode).toBe(202);
      expect(JSON.parse(res2.body)).toEqual({ status: 'duplicate' });
      expect(queue.jobs).toHaveLength(1);
    });

    it('PR opened → one job with correct fields', async () => {
      await store.upsertInstallation({
        id: 77,
        workspaceId: 'ws-77',
        accountLogin: 'acme-corp',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const app = createServer({ config: mockConfig, store, queue, log: false });
      const payload = JSON.stringify({
        action: 'opened',
        installation: { id: 77 },
        repository: { full_name: 'acme-corp/product' },
        pull_request: {
          number: 101,
          draft: false,
          head: { sha: 'sha-head-aaa' },
          base: { sha: 'sha-base-bbb' },
        },
      });

      const res = await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-pr-opened',
        signature: sign(payload),
        payload,
      });
      expect(res.statusCode).toBe(202);
      expect(queue.jobs).toEqual([
        {
          deliveryId: 'del-pr-opened',
          installationId: 77,
          repoFullName: 'acme-corp/product',
          pullNumber: 101,
          headSha: 'sha-head-aaa',
          baseSha: 'sha-base-bbb',
        },
      ]);
    });

    it('draft / unlinked / suspended → no job', async () => {
      await store.upsertInstallation({
        id: 88,
        workspaceId: 'ws-88',
        accountLogin: 'org-88',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const app = createServer({ config: mockConfig, store, queue, log: false });

      // Draft PR
      const draftPayload = JSON.stringify({
        action: 'opened',
        installation: { id: 88 },
        repository: { full_name: 'org-88/repo' },
        pull_request: { number: 2, draft: true, head: { sha: 'h' }, base: { sha: 'b' } },
      });
      await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-draft',
        signature: sign(draftPayload),
        payload: draftPayload,
      });

      // Unlinked PR
      const unlinkedPayload = JSON.stringify({
        action: 'opened',
        installation: { id: 999 },
        repository: { full_name: 'unknown/repo' },
        pull_request: { number: 3, draft: false, head: { sha: 'h' }, base: { sha: 'b' } },
      });
      await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-unlinked',
        signature: sign(unlinkedPayload),
        payload: unlinkedPayload,
      });

      // Suspended PR
      await store.setInstallationSuspended(88, true);
      const suspendedPayload = JSON.stringify({
        action: 'opened',
        installation: { id: 88 },
        repository: { full_name: 'org-88/repo' },
        pull_request: { number: 4, draft: false, head: { sha: 'h' }, base: { sha: 'b' } },
      });
      await postWebhook(app, {
        event: 'pull_request',
        deliveryId: 'del-suspended',
        signature: sign(suspendedPayload),
        payload: suspendedPayload,
      });

      expect(queue.jobs).toHaveLength(0);
    });

    it('installation created → pending', async () => {
      const app = createServer({ config: mockConfig, store, queue, log: false });
      const payload = JSON.stringify({
        action: 'created',
        installation: {
          id: 300,
          account: { login: 'my-team', type: 'Organization' },
          repository_selection: 'all',
        },
      });

      const res = await postWebhook(app, {
        event: 'installation',
        deliveryId: 'del-inst-create',
        signature: sign(payload),
        payload,
      });
      expect(res.statusCode).toBe(202);
      const inst = store.installations.get(300);
      expect(inst?.accountLogin).toBe('my-team');
      expect((inst as { workspaceId?: string }).workspaceId).toBeUndefined();
    });

    it('installation deleted → removed', async () => {
      await store.upsertInstallation({
        id: 400,
        workspaceId: 'ws-400',
        accountLogin: 'to-delete',
        accountType: 'User',
        repositorySelection: 'all',
        suspended: false,
      });

      const app = createServer({ config: mockConfig, store, queue, log: false });
      const payload = JSON.stringify({ action: 'deleted', installation: { id: 400 } });
      const res = await postWebhook(app, {
        event: 'installation',
        deliveryId: 'del-inst-del',
        signature: sign(payload),
        payload,
      });
      expect(res.statusCode).toBe(202);
      expect(store.installations.get(400)).toBeUndefined();
    });

    it('unknown event → ignored', async () => {
      const app = createServer({ config: mockConfig, store, queue, log: false });
      const payload = JSON.stringify({ action: 'created', issue: { id: 1 } });
      const res = await postWebhook(app, {
        event: 'issues',
        deliveryId: 'del-issues',
        signature: sign(payload),
        payload,
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ status: 'ignored', reason: 'unhandled_event_issues' });
      expect(queue.jobs).toHaveLength(0);
    });
  });

  describe('Health and ready endpoints', () => {
    it('GET /health returns 200 { ok: true }', async () => {
      const app = createServer({ config: mockConfig, store, queue, log: false });
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });

    it('GET /ready returns 200 when probes pass', async () => {
      const probes = { store: vi.fn().mockResolvedValue(true), queue: vi.fn().mockResolvedValue(true) };
      const app = createServer({ config: mockConfig, store, queue, log: false, probes });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });

    it('GET /ready returns 503 when store probe fails', async () => {
      const probes = { store: vi.fn().mockResolvedValue(false), queue: vi.fn().mockResolvedValue(true) };
      const app = createServer({ config: mockConfig, store, queue, log: false, probes });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).ok).toBe(false);
    });

    it('GET /ready returns 503 when queue probe fails', async () => {
      const probes = { store: vi.fn().mockResolvedValue(true), queue: vi.fn().mockResolvedValue(false) };
      const app = createServer({ config: mockConfig, store, queue, log: false, probes });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).ok).toBe(false);
    });

    it('GET /ready returns 503 when probe throws', async () => {
      const probes = {
        store: vi.fn().mockRejectedValue(new Error('db connection lost')),
        queue: vi.fn().mockResolvedValue(true),
      };
      const app = createServer({ config: mockConfig, store, queue, log: false, probes });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).ok).toBe(false);
    });
  });

  describe('extraRoutes', () => {
    it('allows registering additional routes for auth/dashboard', async () => {
      const app = createServer({
        config: mockConfig,
        store,
        queue,
        log: false,
        extraRoutes: (instance) => {
          instance.get('/api/workspaces', async () => ({ workspaces: ['ws-1'] }));
        },
      });

      const res = await app.inject({ method: 'GET', url: '/api/workspaces' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ workspaces: ['ws-1'] });
    });
  });
});

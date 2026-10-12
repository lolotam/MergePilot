import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import { createServer } from './create-server.js';

class FakeQueue implements ReviewQueue {
  readonly jobs: ReviewJob[] = [];
  async enqueue(job: ReviewJob): Promise<void> {
    this.jobs.push(job);
  }
}

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

describe('Server structured logging', () => {
  const webhookSecret = 'test-secret';
  const mockConfig: AppConfig = {
    baseUrl: 'https://test.mergepilot.com',
    port: 3000,
    databaseUrl: 'memory:',
    redisUrl: 'redis://localhost:6379',
    masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    github: {
      appId: '12345',
      privateKey: 'fake-private-key',
      webhookSecret,
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

  function sign(payload: string): string {
    return `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`;
  }

  it('produces exactly one completion line with expected fields and no body/headers/query', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });

    const app = createServer({
      config: mockConfig,
      store,
      queue,
      log: logger,
      extraRoutes: (instance) => {
        instance.get('/api/workspaces/:workspaceId/items', async (_req) => {
          return { items: [1, 2, 3] };
        });
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-123/items?sort=desc&secretParam=topSecret',
      headers: {
        'x-request-id': 'custom-req-id-1',
        authorization: 'Bearer secret-auth-token',
        cookie: 'session=secret-session-id',
      },
    });

    expect(res.statusCode).toBe(200);

    const completionLines = lines.filter((l) => l.msg === 'request completed');
    expect(completionLines).toHaveLength(1);

    const log = completionLines[0] as Record<string, unknown>;
    expect(log.reqId).toBe('custom-req-id-1');
    expect(log.method).toBe('GET');
    expect(log.route).toBe('/api/workspaces/:workspaceId/items');
    expect(log.path).toBe('/api/workspaces/ws-123/items');
    expect(log.path).not.toContain('?');
    expect(log.path).not.toContain('sort=desc');
    expect(log.statusCode).toBe(200);
    expect(typeof log.durationMs).toBe('number');
    expect(log.workspaceId).toBe('ws-123');
    expect(log.clientIp).toBe('127.0.0.1');

    // Verify bodies, headers, and query strings are NOT logged in completion line
    expect(log.body).toBeUndefined();
    expect(log.payload).toBeUndefined();
    expect(log.headers).toBeUndefined();
    expect(log.query).toBeUndefined();
    expect(JSON.stringify(log)).not.toContain('secretParam');
    expect(JSON.stringify(log)).not.toContain('secret-auth-token');
    expect(JSON.stringify(log)).not.toContain('secret-session-id');
  });

  it('echos back x-request-id in response headers (round-trip)', async () => {
    const { stream } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = createServer({ config: mockConfig, store, queue, log: logger });

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'round-trip-id-42' },
    });

    expect(res.headers['x-request-id']).toBe('round-trip-id-42');
  });

  it('generates a new x-request-id when missing or invalid and echoes it back', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = createServer({ config: mockConfig, store, queue, log: logger });

    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { 'x-request-id': '<script>invalid</script>' },
    });

    const returnedId = res.headers['x-request-id'];
    expect(returnedId).toBeDefined();
    expect(returnedId).not.toContain('<script>');

    const readyLog = lines.find((l) => l.path === '/ready');
    expect(readyLog?.reqId).toBe(returnedId);
  });

  it('logs 4xx at warn level with error code', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });

    const app = createServer({
      config: mockConfig,
      store,
      queue,
      log: logger,
      extraRoutes: (instance) => {
        instance.get('/api/workspaces/:workspaceId/fail-400', async (_req, reply) => {
          return reply.status(400).send({ error: { code: 'bad_input', message: 'Invalid data' } });
        });
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-99/fail-400',
    });

    expect(res.statusCode).toBe(400);

    const warnLines = lines.filter((l) => l.level === 40 && l.msg === 'request completed');
    expect(warnLines).toHaveLength(1);
    const log = warnLines[0] as Record<string, unknown>;
    expect(log.statusCode).toBe(400);
    expect(log.code).toBe('bad_input');
    expect(log.workspaceId).toBe('ws-99');
  });

  it('logs 5xx at error level with error name, redacted message, and stack', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });

    const fakeSecret = ['sk', 'ant', 'api03', 'z'.repeat(25)].join('-');
    const app = createServer({
      config: mockConfig,
      store,
      queue,
      log: logger,
      extraRoutes: (instance) => {
        instance.get('/crash', async () => {
          throw new Error(`Database connection failed with key ${fakeSecret}`);
        });
      },
    });

    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);

    const errorLines = lines.filter((l) => l.level === 50 && l.msg === 'request completed');
    expect(errorLines).toHaveLength(1);
    const log = errorLines[0] as Record<string, unknown>;
    expect(log.statusCode).toBe(500);
    const errObj = log.err as { type: string; message: string; stack: string };
    expect(errObj.type).toBe('Error');
    expect(errObj.message).not.toContain(fakeSecret);
    expect(errObj.message).toContain('[REDACTED:anthropic]');
    expect(errObj.stack).toBeDefined();
    expect(errObj.stack).not.toContain(fakeSecret);
  });

  it('skips /health at info level and logs at debug level', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', level: 'debug', stream });
    const app = createServer({ config: mockConfig, store, queue, log: logger });

    await app.inject({ method: 'GET', url: '/health' });

    const healthLogs = lines.filter((l) => l.path === '/health');
    expect(healthLogs).toHaveLength(1);
    // Pino debug level is 20
    expect(healthLogs[0]?.level).toBe(20);
  });

  it('logs webhook outcome lines for invalid-signature, duplicate, queued, and ignored', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });

    await store.upsertInstallation({
      id: 101,
      workspaceId: 'ws-101',
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });

    const app = createServer({ config: mockConfig, store, queue, log: logger });

    // 1. Invalid signature
    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'del-bad-sig',
        'x-hub-signature-256': 'sha256=bad',
      },
      payload: JSON.stringify({ action: 'opened' }),
    });

    const badSigLog = lines.find((l) => l.outcome === 'invalid-signature');
    expect(badSigLog).toBeDefined();
    expect(badSigLog?.deliveryId).toBe('del-bad-sig');

    // 2. Queued valid webhook
    const validPayload = JSON.stringify({
      action: 'opened',
      installation: { id: 101 },
      repository: { full_name: 'acme/repo' },
      pull_request: { number: 42, draft: false, head: { sha: 'h1' }, base: { sha: 'b1' } },
    });
    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'del-queued',
        'x-hub-signature-256': sign(validPayload),
      },
      payload: validPayload,
    });

    const queuedLog = lines.find((l) => l.outcome === 'queued');
    expect(queuedLog).toBeDefined();
    expect(queuedLog?.deliveryId).toBe('del-queued');
    expect(queuedLog?.repo).toBe('acme/repo');
    expect(queuedLog?.pr).toBe(42);

    // 3. Duplicate
    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'del-queued',
        'x-hub-signature-256': sign(validPayload),
      },
      payload: validPayload,
    });

    const dupLog = lines.find((l) => l.outcome === 'duplicate');
    expect(dupLog).toBeDefined();

    // 4. Ignored (draft PR)
    const draftPayload = JSON.stringify({
      action: 'opened',
      installation: { id: 101 },
      repository: { full_name: 'acme/repo' },
      pull_request: { number: 43, draft: true, head: { sha: 'h2' }, base: { sha: 'b2' } },
    });
    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'del-draft',
        'x-hub-signature-256': sign(draftPayload),
      },
      payload: draftPayload,
    });

    const ignoredLog = lines.find((l) => l.outcome === 'ignored');
    expect(ignoredLog).toBeDefined();
  });
});

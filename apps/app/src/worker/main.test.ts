import { generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../core/config.js';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewJob } from '../core/types.js';
import {
  attachShutdownHandlers,
  createGitHubAppFactory,
  createReviewWorker,
  createWorker,
  startHealthServer,
} from './main.js';
import type { ProcessReviewDeps } from './types.js';

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const capturedWorkerInstances: Array<{
  name: string;
  processor: (job: { data: ReviewJob }) => Promise<void>;
  opts: { concurrency: number; connection?: unknown };
  close: () => Promise<void>;
}> = [];

vi.mock('bullmq', () => {
  return {
    Worker: class MockBullMQWorker {
      name: string;
      processor: (job: { data: ReviewJob }) => Promise<void>;
      opts: { concurrency: number; connection?: unknown };
      close = mockWorkerClose;

      constructor(
        name: string,
        processor: (job: { data: ReviewJob }) => Promise<void>,
        opts: { concurrency: number; connection?: unknown },
      ) {
        this.name = name;
        this.processor = processor;
        this.opts = opts;
        capturedWorkerInstances.push(this);
      }
    },
  };
});

describe('worker/main', { timeout: 20000 }, () => {
  const masterKey = randomBytes(32).toString('base64');
  const baseConfig: AppConfig = {
    baseUrl: 'https://test.mergepilot.com',
    port: 3000,
    databaseUrl: 'memory:',
    redisUrl: 'memory:',
    masterKey,
    github: {
      appId: '12345',
      privateKey: 'fake-private-key',
      webhookSecret: 'fake-webhook-secret',
      clientId: 'gh-id',
      clientSecret: 'gh-sec',
      appSlug: 'my-bot-app',
    },
    google: { clientId: 'google-id', clientSecret: 'google-sec' },
    authSecret: 'better-auth-secret-1234567890',
  };

  beforeEach(() => {
    mockWorkerClose.mockClear();
    capturedWorkerInstances.length = 0;
  });

  describe('createGitHubAppFactory', () => {
    it('builds a client with publisherLogin <appSlug>[bot]', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listFiles: vi.fn(),
            get: vi.fn(),
            listReviews: vi.fn(),
            createReview: vi.fn(),
          },
          repos: {
            getContent: vi.fn(),
          },
        },
      };

      const mockApp = {
        getInstallationOctokit: vi.fn().mockResolvedValue(mockOctokit),
      };

      const factory = createGitHubAppFactory(
        {
          appId: baseConfig.github.appId,
          privateKey: baseConfig.github.privateKey,
          appSlug: baseConfig.github.appSlug,
        },
        () => mockApp as unknown as import('@octokit/app').App,
      );

      const result = await factory(100);

      expect(result.publisherLogin).toBe('my-bot-app[bot]');
      expect(result.client).toBeDefined();
      expect(typeof result.client.getPullRequest).toBe('function');
      expect(mockApp.getInstallationOctokit).toHaveBeenCalledWith(100);
    });

    it('real App installation clients reach GitHub REST endpoints (no app mock)', async () => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const calls: string[] = [];
      const fetchStub = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const body = url.endsWith('/app/installations/100/access_tokens')
          ? { token: 'ghs_t', expires_at: '2099-01-01T00:00:00Z', permissions: {}, repository_selection: 'all' }
          : { number: 7, head: { sha: 'abc' }, base: { sha: 'def' } };
        return new Response(JSON.stringify(body), {
          status: url.endsWith('/access_tokens') ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetchStub);
      try {
        const factory = createGitHubAppFactory({ appId: '1', privateKey, appSlug: 'my-bot-app' });
        const { client } = await factory(100);
        const pr = await client.getPullRequest({ owner: 'o', repo: 'r', pull_number: 7 });
        expect(pr.number).toBe(7);
        expect(calls.some((u) => u.endsWith('/repos/o/r/pulls/7'))).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('Worker health HTTP endpoint', () => {
    it('serves GET /health with 200 OK on WORKER_HEALTH_PORT', async () => {
      const healthServer = await startHealthServer(0); // ephemeral port
      const address = healthServer.address() as import('node:net').AddressInfo;
      const port = address.port;

      try {
        const res = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}/health`, (response) => {
            let data = '';
            response.on('data', (chunk) => {
              data += chunk;
            });
            response.on('end', () => {
              resolve({ statusCode: response.statusCode, body: data });
            });
          }).on('error', reject);
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, worker: 'running' });
      } finally {
        await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      }
    });
  });

  describe('createReviewWorker and worker app', () => {
    it('creates worker with concurrency 2 by default', () => {
      const store = new MemoryStore();
      const deps: ProcessReviewDeps = {
        store,
        credentials: { resolve: vi.fn() },
        githubAppFactory: vi.fn(),
      };

      const worker = createReviewWorker(deps, {
        connection: { host: 'localhost', port: 6379 },
      });

      expect(worker.name).toBe('reviews');
      expect(worker.opts.concurrency).toBe(2);
    });

    it('creates full worker instance via createWorker with services and health server', async () => {
      const workerInstance = await createWorker({
        env: {
          MERGEPILOT_BASE_URL: 'https://test.mergepilot.com',
          PORT: '3000',
          DATABASE_URL: 'memory:',
          REDIS_URL: 'memory:',
          MERGEPILOT_MASTER_KEY: masterKey,
          GITHUB_APP_ID: '12345',
          GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
          GITHUB_WEBHOOK_SECRET: 'fake-webhook-secret',
          GITHUB_CLIENT_ID: 'gh-id',
          GITHUB_CLIENT_SECRET: 'gh-sec',
          GOOGLE_CLIENT_ID: 'goog-id',
          GOOGLE_CLIENT_SECRET: 'goog-sec',
          BETTER_AUTH_SECRET: 'better-auth-secret-1234567890',
          WORKER_CONCURRENCY: '4',
          WORKER_HEALTH_PORT: '0', // ephemeral
        },
      });

      try {
        expect(workerInstance.services).toBeDefined();
        expect(workerInstance.healthServer).toBeDefined();
        expect(workerInstance.worker).toBeDefined();
      } finally {
        await workerInstance.stop();
      }
    });

    it('attaches graceful shutdown handlers to SIGTERM and SIGINT', async () => {
      const store = new MemoryStore();
      const deps: ProcessReviewDeps = {
        store,
        credentials: { resolve: vi.fn() },
        githubAppFactory: vi.fn(),
      };

      const worker = createReviewWorker(deps);

      const signalHandlers: Record<string, () => Promise<void>> = {};
      const fakeProcess = {
        on: (event: string, handler: () => Promise<void>) => {
          signalHandlers[event] = handler;
        },
      };

      attachShutdownHandlers(worker, fakeProcess);

      expect(signalHandlers['SIGTERM']).toBeDefined();
      expect(signalHandlers['SIGINT']).toBeDefined();

      await signalHandlers['SIGTERM']?.();
      expect(mockWorkerClose).toHaveBeenCalled();
    });

    it('sweeps stale runs on worker startup', async () => {
      const store = new MemoryStore();
      const failStaleSpy = vi.spyOn(store, 'failStaleRuns');

      const workerInstance = await createWorker({
        env: {
          MERGEPILOT_BASE_URL: 'https://test.mergepilot.com',
          PORT: '3000',
          DATABASE_URL: 'memory:',
          REDIS_URL: 'memory:',
          MERGEPILOT_MASTER_KEY: masterKey,
          GITHUB_APP_ID: '12345',
          GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
          GITHUB_WEBHOOK_SECRET: 'fake-webhook-secret',
          GITHUB_CLIENT_ID: 'gh-id',
          GITHUB_CLIENT_SECRET: 'gh-sec',
          GOOGLE_CLIENT_ID: 'goog-id',
          GOOGLE_CLIENT_SECRET: 'goog-sec',
          BETTER_AUTH_SECRET: 'better-auth-secret-1234567890',
          WORKER_CONCURRENCY: '1',
          WORKER_HEALTH_PORT: '0',
        },
        services: {
          store,
          vault: {} as unknown as import('../core/types.js').Vault,
          credentials: {} as unknown as import('../credentials/service.js').CredentialService,
          queue: {} as unknown as import('../core/types.js').ReviewQueue,
          close: vi.fn(),
        },
      });

      try {
        expect(failStaleSpy).toHaveBeenCalled();
        const calledArg = failStaleSpy.mock.calls[0]?.[0];
        expect(calledArg).toBeInstanceOf(Date);
        // Should be approximately 30 minutes in the past
        const diffMs = Date.now() - (calledArg as Date).getTime();
        expect(diffMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
        expect(diffMs).toBeLessThanOrEqual(31 * 60 * 1000);
      } finally {
        await workerInstance.stop();
      }
    });
  });
});

import { randomBytes } from 'node:crypto';
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
  });
});

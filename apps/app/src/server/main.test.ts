import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import { createMainServer } from './main.js';

describe('server/main', () => {
  const fakeEnv: Record<string, string> = {
    MERGEPILOT_BASE_URL: 'https://app.mergepilot.com',
    DATABASE_URL: 'memory:',
    REDIS_URL: 'memory:',
    MERGEPILOT_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: 'private-key-test',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret-test',
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-sec',
    GOOGLE_CLIENT_ID: 'goog-id',
    GOOGLE_CLIENT_SECRET: 'goog-sec',
    BETTER_AUTH_SECRET: 'auth-sec-12345678',
    PORT: '4000',
  };

  it('initializes with MemoryStore when DATABASE_URL is memory:', async () => {
    const serverInstance = await createMainServer({ env: fakeEnv });
    expect(serverInstance.store).toBeInstanceOf(MemoryStore);
    expect(serverInstance.config.port).toBe(4000);

    const res = await serverInstance.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    await serverInstance.stop();
  });

  it('throws when DATABASE_URL is not memory: and no factory provided', async () => {
    const postgresEnv = { ...fakeEnv, DATABASE_URL: 'postgres://localhost:5432/db' };
    await expect(createMainServer({ env: postgresEnv })).rejects.toThrow(
      /Unsupported databaseUrl "postgres:\/\/localhost:5432\/db"/,
    );
  });

  it('allows injecting storeFactory and queueFactory', async () => {
    const customStore = new MemoryStore();
    const enqueued: ReviewJob[] = [];
    const customQueue: ReviewQueue = {
      async enqueue(job) {
        enqueued.push(job);
      },
    };

    const serverInstance = await createMainServer({
      env: { ...fakeEnv, DATABASE_URL: 'postgres://custom' },
      storeFactory: vi.fn().mockResolvedValue(customStore),
      queueFactory: vi.fn().mockResolvedValue(customQueue),
    });

    expect(serverInstance.store).toBe(customStore);
    expect(serverInstance.queue).toBe(customQueue);

    await serverInstance.stop();
  });

  it('stop calls app.close and queue.close', async () => {
    const queueClose = vi.fn().mockResolvedValue(undefined);
    const customQueue = {
      async enqueue() {},
      close: queueClose,
    };

    const serverInstance = await createMainServer({
      env: fakeEnv,
      queueFactory: () => customQueue,
    });

    await serverInstance.stop();
    expect(queueClose).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import type { ReviewJob } from '../core/types.js';
import { attachShutdownHandlers, createReviewWorker } from './main.js';
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

describe('worker/main', () => {
  beforeEach(() => {
    mockWorkerClose.mockClear();
    capturedWorkerInstances.length = 0;
  });

  it('creates a BullMQ Worker for queue "reviews" with concurrency 2 by default', () => {
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

  it('allows overriding concurrency if needed', () => {
    const store = new MemoryStore();
    const deps: ProcessReviewDeps = {
      store,
      credentials: { resolve: vi.fn() },
      githubAppFactory: vi.fn(),
    };

    const worker = createReviewWorker(deps, {
      connection: { host: 'localhost', port: 6379 },
      concurrency: 4,
    });

    expect(worker.opts.concurrency).toBe(4);
  });

  it('processes incoming jobs using processReviewJob', async () => {
    const store = new MemoryStore();
    const processReviewModule = await import('./process-review.js');
    const spy = vi.spyOn(processReviewModule, 'processReviewJob').mockResolvedValue({
      status: 'completed',
      costUsd: 0.05,
      detail: null,
    });

    const deps: ProcessReviewDeps = {
      store,
      credentials: { resolve: vi.fn() },
      githubAppFactory: vi.fn(),
    };

    createReviewWorker(deps);

    const instance = capturedWorkerInstances[0];
    expect(instance).toBeDefined();

    const jobData: ReviewJob = {
      deliveryId: 'del-1',
      installationId: 10,
      repoFullName: 'owner/repo',
      pullNumber: 5,
      headSha: 'head123',
      baseSha: 'base123',
    };

    await instance?.processor({ data: jobData });
    expect(spy).toHaveBeenCalledWith(jobData, deps);
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

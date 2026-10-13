import { PRICE_SOURCE_URLS, type FetchLike } from '@mergepilot/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import {
  MAINTENANCE_QUEUE,
  REFRESH_PRICES_CRON,
  REFRESH_PRICES_JOB_NAME,
  REFRESH_PRICES_SCHEDULER_ID,
  RETENTION_CRON,
  RETENTION_JOB_NAME,
  RETENTION_SCHEDULER_ID,
  startMaintenanceScheduler,
} from './retention-schedule.js';

const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
const add = vi.fn().mockResolvedValue(undefined);
const queueClose = vi.fn().mockResolvedValue(undefined);
const workerClose = vi.fn().mockResolvedValue(undefined);
const workers: Array<{ name: string; processor: (job: { name: string }) => Promise<void>; opts: { concurrency: number } }> = [];

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(readonly name: string) {}
    upsertJobScheduler = upsertJobScheduler;
    add = add;
    close = queueClose;
  },
  Worker: class {
    close = workerClose;
    constructor(
      readonly name: string,
      readonly processor: (job: { name: string }) => Promise<void>,
      readonly opts: { concurrency: number },
    ) {
      workers.push(this);
    }
  },
}));

const NOW = new Date('2026-10-13T12:00:00.000Z');
const CONNECTION = { host: 'localhost', port: 6379 };
const priced = (model: string) => ({ provider: 'openrouter', model, inputPerMTok: 1, outputPerMTok: 1, source: 'openrouter' as const });

describe('maintenance scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workers.length = 0;
  });

  it('upserts a daily 03:00 UTC schedule and runs retention for that job only', async () => {
    const store = new MemoryStore();
    await store.replaceModelPrices('openrouter', [priced('x')], NOW);
    const start = vi.spyOn(store, 'startMaintenanceRun');
    const scheduler = await startMaintenanceScheduler(store, CONNECTION, undefined, { now: () => NOW });

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      RETENTION_SCHEDULER_ID,
      { pattern: RETENTION_CRON, tz: 'UTC' },
      expect.objectContaining({ name: RETENTION_JOB_NAME }),
    );
    expect(RETENTION_CRON).toBe('0 3 * * *');
    const worker = workers[0]!;
    expect(worker.name).toBe(MAINTENANCE_QUEUE);
    expect(worker.opts.concurrency).toBe(1);

    await worker.processor({ name: 'something-else' });
    expect(start).not.toHaveBeenCalled();
    await worker.processor({ name: RETENTION_JOB_NAME });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('retention', expect.any(Date));
    expect((await store.getLatestMaintenanceRun('retention'))?.finishedAt).toBeInstanceOf(Date);

    await scheduler.close();
    expect(workerClose).toHaveBeenCalled();
    expect(queueClose).toHaveBeenCalled();
  });

  it('upserts a daily 02:30 UTC price refresh and runs it for that job', async () => {
    const store = new MemoryStore();
    await store.replaceModelPrices('openrouter', [priced('x')], NOW);
    const fetchFn = vi.fn(async (url: string) => {
      if (url === PRICE_SOURCE_URLS.openrouter) {
        return new Response(JSON.stringify({ data: [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0' } }] }));
      }
      return new Response('down', { status: 503 });
    });
    const scheduler = await startMaintenanceScheduler(store, CONNECTION, undefined, {
      priceFetch: fetchFn as unknown as FetchLike,
      now: () => NOW,
    });
    expect(REFRESH_PRICES_CRON).toBe('30 2 * * *');
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      REFRESH_PRICES_SCHEDULER_ID,
      { pattern: REFRESH_PRICES_CRON, tz: 'UTC' },
      expect.objectContaining({ name: REFRESH_PRICES_JOB_NAME }),
    );
    // Fresh prices: nothing is queued at startup.
    expect(add).not.toHaveBeenCalled();

    await workers[0]!.processor({ name: REFRESH_PRICES_JOB_NAME });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(await store.getModelPrice('openrouter', 'a/b')).toMatchObject({ inputPerMTok: 1 });
    expect(await store.getLatestMaintenanceRun('refresh-prices')).toMatchObject({ deletedCount: 1 });
    await scheduler.close();
  });

  it('queues one price refresh at startup when the table is empty or the prices are older than 24 h', async () => {
    const empty = new MemoryStore();
    await (await startMaintenanceScheduler(empty, CONNECTION, undefined, { now: () => NOW })).close();
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(REFRESH_PRICES_JOB_NAME, {}, expect.any(Object));

    const stale = new MemoryStore();
    await stale.replaceModelPrices('openrouter', [priced('x')], new Date(NOW.getTime() - 25 * 60 * 60 * 1000));
    await (await startMaintenanceScheduler(stale, CONNECTION, undefined, { now: () => NOW })).close();
    expect(add).toHaveBeenCalledTimes(2);
  });
});

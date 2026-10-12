import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import {
  MAINTENANCE_QUEUE,
  RETENTION_CRON,
  RETENTION_JOB_NAME,
  RETENTION_SCHEDULER_ID,
  startMaintenanceScheduler,
} from './retention-schedule.js';

const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
const queueClose = vi.fn().mockResolvedValue(undefined);
const workerClose = vi.fn().mockResolvedValue(undefined);
const workers: Array<{ name: string; processor: (job: { name: string }) => Promise<void>; opts: { concurrency: number } }> = [];

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(readonly name: string) {}
    upsertJobScheduler = upsertJobScheduler;
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

describe('maintenance scheduler', () => {
  it('upserts a daily 03:00 UTC schedule and runs retention for that job only', async () => {
    const store = new MemoryStore();
    const start = vi.spyOn(store, 'startMaintenanceRun');
    const scheduler = await startMaintenanceScheduler(store, { host: 'localhost', port: 6379 });

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
    expect((await store.getLatestMaintenanceRun('retention'))?.finishedAt).toBeInstanceOf(Date);

    await scheduler.close();
    expect(workerClose).toHaveBeenCalled();
    expect(queueClose).toHaveBeenCalled();
  });
});

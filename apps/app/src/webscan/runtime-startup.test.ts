import { describe, expect, it, vi } from 'vitest';
import { startWebScanRuntime, type WebScanRuntimeOptions } from './runtime.js';

const queue = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
const setup = vi.hoisted(() => ({ concurrency: vi.fn(), scheduler: vi.fn(), worker: vi.fn() }));
vi.mock('./queue.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./queue.js')>(),
  createWebScanQueue: () => queue,
  applyGlobalConcurrency: setup.concurrency,
  registerWebScanTick: setup.scheduler,
  createWebScanWorker: setup.worker,
}));

describe('failed scanner queue startup', () => {
  it.each(['concurrency', 'scheduler', 'worker'] as const)('closes the queue when the %s stage fails', async (stage) => {
    queue.close.mockClear();
    setup.concurrency.mockReset().mockResolvedValue(undefined);
    setup.scheduler.mockReset().mockResolvedValue(undefined);
    setup.worker.mockReset().mockReturnValue({ close: vi.fn() });
    const failure = new Error('Redis unavailable');
    setup[stage].mockRejectedValueOnce(failure);
    const options = {
      db: {}, vault: {}, pool: {}, connection: {}, platformAdmins: [],
    } as unknown as WebScanRuntimeOptions;

    await expect(startWebScanRuntime(options)).rejects.toBe(failure);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });
});

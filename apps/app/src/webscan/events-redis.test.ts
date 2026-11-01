import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RedisWebScanEventBus, webScanEventsChannel, type WebScanEvent } from './events.js';

const event: WebScanEvent = {
  scanId: 'scan', siteId: 'site', kind: 'progress', status: 'running',
  requests: 1, pages: 1, elapsedMs: 1,
};

describe('a failed Redis progress subscription', () => {
  it('rolls back concurrent listeners and retries the channel after failure', async () => {
    const subscriber = Object.assign(new EventEmitter(), {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(async () => 0),
      quit: vi.fn(async () => 'OK'),
    });
    let rejectSubscription: (error: Error) => void = () => {};
    subscriber.subscribe.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectSubscription = reject;
    })).mockResolvedValue(1);
    const bus = new RedisWebScanEventBus({
      publisher: { publish: async () => 0, quit: async () => 'OK' },
      subscriber: () => subscriber,
    });
    const first = vi.fn();
    const second = vi.fn();
    const failed = Promise.allSettled([
      bus.subscribe('site', first),
      bus.subscribe('site', second),
    ]);
    rejectSubscription(new Error('Redis disconnected'));
    expect((await failed).map((result) => result.status)).toEqual(['rejected', 'rejected']);

    const live = vi.fn();
    const unsubscribe = await bus.subscribe('site', live);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(subscriber.listenerCount('message')).toBe(1);
    subscriber.emit('message', webScanEventsChannel('site'), JSON.stringify(event));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledWith(event);
    unsubscribe();
    subscriber.emit('message', webScanEventsChannel('site'), JSON.stringify(event));
    expect(live).toHaveBeenCalledTimes(1);
    await bus.close();
  });
});

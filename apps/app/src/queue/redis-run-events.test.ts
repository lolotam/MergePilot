import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '../core/run-events.js';
import { RedisRunEventBus, type RunEventsSubscriberClient } from './redis-run-events.js';

function fakeClients() {
  const published: Array<[string, string]> = [];
  const publisher = {
    publish: vi.fn(async (channel: string, message: string) => {
      published.push([channel, message]);
      return 1;
    }),
    quit: vi.fn(async () => 'OK'),
  };
  const emitter = new EventEmitter();
  const subscriber = {
    subscribe: vi.fn(async (_channel: string) => 1),
    unsubscribe: vi.fn(async (_channel: string) => 0),
    on: ((event: string, listener: (...args: never[]) => void) => emitter.on(event, listener)) as RunEventsSubscriberClient['on'],
    quit: vi.fn(async () => 'OK'),
  } satisfies RunEventsSubscriberClient;
  const makeSubscriber = vi.fn(() => subscriber);
  const deliver = (channel: string, message: string) => emitter.emit('message', channel, message);
  const dropConnection = () => emitter.emit('close');
  return { published, publisher, subscriber, makeSubscriber, deliver, dropConnection };
}

const event: RunEvent = { workspaceId: 'ws-1', runId: 'run-1', status: 'completed', kind: 'updated' };

describe('RedisRunEventBus', () => {
  it('publishes the four-field event as JSON on the workspace channel, without opening a subscriber', () => {
    const c = fakeClients();
    const bus = new RedisRunEventBus({ publisher: c.publisher, subscriber: c.makeSubscriber });

    bus.publish({ ...event, extra: 'repo text' } as RunEvent);

    expect(c.published).toEqual([['mergepilot:runs:ws-1', JSON.stringify(event)]]);
    expect(c.makeSubscriber).not.toHaveBeenCalled();
  });

  it('never throws when Redis refuses a publish; it reports the error name only', async () => {
    const c = fakeClients();
    c.publisher.publish.mockRejectedValueOnce(Object.assign(new Error('redis://user:pw@host down'), { name: 'ConnectionError' }));
    const onError = vi.fn();
    const bus = new RedisRunEventBus({ publisher: c.publisher, subscriber: c.makeSubscriber, onError });

    expect(() => bus.publish(event)).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('ConnectionError'));
  });

  it('subscribes a channel once for many listeners and unsubscribes after the last one leaves', async () => {
    const c = fakeClients();
    const bus = new RedisRunEventBus({ publisher: c.publisher, subscriber: c.makeSubscriber });
    const got1: RunEvent[] = [];
    const got2: RunEvent[] = [];

    const stop1 = await bus.subscribe('ws-1', (e) => got1.push(e));
    const stop2 = await bus.subscribe('ws-1', (e) => got2.push(e));
    expect(c.subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(c.subscriber.subscribe).toHaveBeenCalledWith('mergepilot:runs:ws-1');

    c.deliver('mergepilot:runs:ws-1', JSON.stringify(event));
    expect(got1).toEqual([event]);
    expect(got2).toEqual([event]);

    stop1();
    stop1();
    expect(c.subscriber.unsubscribe).not.toHaveBeenCalled();
    stop2();
    expect(c.subscriber.unsubscribe).toHaveBeenCalledWith('mergepilot:runs:ws-1');
    expect(c.makeSubscriber).toHaveBeenCalledTimes(1);
  });

  it('drops malformed messages and messages naming another workspace than their channel', async () => {
    const c = fakeClients();
    const bus = new RedisRunEventBus({ publisher: c.publisher, subscriber: c.makeSubscriber });
    const got: RunEvent[] = [];
    await bus.subscribe('ws-1', (e) => got.push(e));

    c.deliver('mergepilot:runs:ws-1', 'garbage');
    c.deliver('mergepilot:runs:ws-1', JSON.stringify({ ...event, workspaceId: 'ws-2' }));
    c.deliver('mergepilot:runs:ws-2', JSON.stringify({ ...event, workspaceId: 'ws-2' }));

    expect(got).toEqual([]);
  });

  it('releases the channel when the Redis subscribe fails, and closes both connections', async () => {
    const c = fakeClients();
    c.subscriber.subscribe.mockRejectedValueOnce(new Error('down'));
    const bus = new RedisRunEventBus({ publisher: c.publisher, subscriber: c.makeSubscriber });

    await expect(bus.subscribe('ws-1', () => {})).rejects.toThrow('down');
    await bus.subscribe('ws-1', () => {});
    expect(c.subscriber.subscribe).toHaveBeenCalledTimes(2);

    await bus.close();
    expect(c.publisher.quit).toHaveBeenCalledTimes(1);
    expect(c.subscriber.quit).toHaveBeenCalledTimes(1);
    bus.publish(event);
    expect(c.publisher.publish).not.toHaveBeenCalled();
  });

  it('makes concurrent listeners wait for the same subscribe and fail with it', async () => {
    const c = fakeClients();
    let reject!: (err: Error) => void;
    c.subscriber.subscribe.mockImplementationOnce(() => new Promise<number>((_, r) => { reject = r; }));
    const bus = new RedisRunEventBus({ publisher: c.publisher, subscriber: c.makeSubscriber });

    const first = bus.subscribe('ws-1', () => {});
    const second = bus.subscribe('ws-1', () => {});
    reject(new Error('subscribe refused'));
    await expect(first).rejects.toThrow('subscribe refused');
    await expect(second).rejects.toThrow('subscribe refused');

    // Nothing is left counted: the next listener subscribes Redis again.
    await bus.subscribe('ws-1', () => {});
    expect(c.subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  it('tells every listener when the Redis connection drops, and stops after they leave', async () => {
    const c = fakeClients();
    const bus = new RedisRunEventBus({ publisher: c.publisher, subscriber: c.makeSubscriber });
    const lost1 = vi.fn();
    const lost2 = vi.fn();
    const stop1 = await bus.subscribe('ws-1', () => {}, lost1);
    await bus.subscribe('ws-2', () => {}, lost2);

    c.dropConnection();
    expect(lost1).toHaveBeenCalledTimes(1);
    expect(lost2).toHaveBeenCalledTimes(1);

    stop1();
    c.dropConnection();
    expect(lost1).toHaveBeenCalledTimes(1);
    expect(lost2).toHaveBeenCalledTimes(2);
  });
});

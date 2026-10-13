import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import {
  parseRunEvent,
  runEventsChannel,
  toRunEventPayload,
  type RunEvent,
  type RunEventBus,
  type RunEventListener,
} from '../core/run-events.js';

/** The ioredis calls the bus uses; tests pass fakes. */
export interface RunEventsPublisherClient {
  publish(channel: string, message: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RunEventsSubscriberClient {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export interface RedisRunEventBusOptions {
  redisUrl?: string | undefined;
  publisher?: RunEventsPublisherClient | undefined;
  /** Created on the first subscribe; the worker only publishes and never opens it. */
  subscriber?: (() => RunEventsSubscriberClient) | undefined;
  /** Error names only: a driver message can carry the connection URL. */
  onError?: ((errorName: string) => void) | undefined;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}

/** A dedicated client per role: a Redis connection in subscriber mode cannot publish. */
function createClient(redisUrl: string, onError: (name: string) => void): Redis {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    // Fail fast instead of queueing forever: a lost live event only delays the next refetch.
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
  });
  client.on('error', (err: unknown) => onError(errorName(err)));
  return client;
}

/**
 * Run events over Redis pub/sub (ADR-0021), one channel per workspace. One subscriber connection
 * per process carries every open stream: each workspace channel is subscribed while at least one
 * stream listens to it, and messages fan out in process.
 */
export class RedisRunEventBus implements RunEventBus {
  private readonly publisher: RunEventsPublisherClient;
  private readonly makeSubscriber: () => RunEventsSubscriberClient;
  private subscriber: RunEventsSubscriberClient | undefined;
  private readonly local = new EventEmitter();
  private readonly channelUsers = new Map<string, number>();
  /** The Redis subscribe of a channel, shared by every listener that joins while it is pending. */
  private readonly channelReady = new Map<string, Promise<void>>();
  private readonly onError: (name: string) => void;
  private closed = false;

  constructor(options: RedisRunEventBusOptions) {
    this.onError = options.onError ?? (() => {});
    const { redisUrl } = options;
    if (!options.publisher && !redisUrl) throw new Error('RedisRunEventBus requires redisUrl or clients');
    this.publisher = options.publisher ?? createClient(redisUrl as string, this.onError);
    this.makeSubscriber = options.subscriber ?? (() => createClient(redisUrl as string, this.onError));
    this.local.setMaxListeners(0);
  }

  publish(event: RunEvent): void {
    if (this.closed) return;
    const payload = toRunEventPayload(event);
    this.publisher
      .publish(runEventsChannel(payload.workspaceId), JSON.stringify(payload))
      .catch((err: unknown) => this.onError(errorName(err)));
  }

  async subscribe(workspaceId: string, listener: RunEventListener): Promise<() => void> {
    if (this.closed) throw new Error('run event bus is closed');
    const channel = runEventsChannel(workspaceId);
    const subscriber = this.ensureSubscriber();
    const users = this.channelUsers.get(channel) ?? 0;
    this.channelUsers.set(channel, users + 1);
    let ready = this.channelReady.get(channel);
    if (users === 0 || !ready) {
      ready = subscriber.subscribe(channel).then(() => undefined);
      this.channelReady.set(channel, ready);
    }
    try {
      // Every concurrent listener waits for the same subscribe and fails with it.
      await ready;
    } catch (err) {
      if (this.channelReady.get(channel) === ready) this.channelReady.delete(channel);
      this.release(channel);
      throw err;
    }
    const handler = (event: RunEvent) => listener(event);
    this.local.on(channel, handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.local.off(channel, handler);
      this.release(channel);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.local.removeAllListeners();
    this.channelUsers.clear();
    this.channelReady.clear();
    const quits = [this.publisher.quit()];
    if (this.subscriber) quits.push(this.subscriber.quit());
    await Promise.allSettled(quits);
  }

  private ensureSubscriber(): RunEventsSubscriberClient {
    if (!this.subscriber) {
      const subscriber = this.makeSubscriber();
      subscriber.on('message', (channel, message) => {
        const event = parseRunEvent(message);
        // A message must name the workspace of the channel it came on.
        if (!event || runEventsChannel(event.workspaceId) !== channel) return;
        this.local.emit(channel, event);
      });
      this.subscriber = subscriber;
    }
    return this.subscriber;
  }

  private release(channel: string): void {
    const users = (this.channelUsers.get(channel) ?? 1) - 1;
    if (users > 0) {
      this.channelUsers.set(channel, users);
      return;
    }
    this.channelUsers.delete(channel);
    this.channelReady.delete(channel);
    if (this.closed || !this.subscriber) return;
    this.subscriber.unsubscribe(channel).catch((err: unknown) => this.onError(errorName(err)));
  }
}

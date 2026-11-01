import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';

/**
 * The live progress of a scan (ADR-0052 section 7).
 *
 * The progress of a scan streams to the page the same way the live run updates do
 * (ADR-0021). Only bounded counters and ids travel: the number of requests, the
 * number of pages, the elapsed time, the state of the scan and the ids of the scan
 * and the site. No hostname, no URL, no target text, no evidence and no credential
 * ever reaches this channel, so a leaked event can never expose what was scanned.
 *
 * The scanner is platform-global, so its events have their own namespace and do not
 * share the review run channels.
 */

/** What happened to a scan. */
export type WebScanEventKind = 'progress' | 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

/** The states a scan can be in. */
export type WebScanEventStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

/** One progress event of a scan. */
export interface WebScanEvent {
  scanId: string;
  siteId: string;
  kind: WebScanEventKind;
  status: WebScanEventStatus;
  /** The number of requests the scan made so far. */
  requests: number;
  /** The number of pages the scan visited so far. */
  pages: number;
  /** The milliseconds the scan ran so far. */
  elapsedMs: number;
}

export type WebScanEventListener = (event: WebScanEvent) => void;

/** Publishing never throws and never blocks the caller. */
export interface WebScanEventPublisher {
  publish(event: WebScanEvent): void;
}

/** The event bus of the scanner. */
export interface WebScanEventBus extends WebScanEventPublisher {
  /**
   * Listens to the events of one site. `onLost` is called when the delivery may have
   * missed events, so the listener can end its stream and reconnect.
   */
  subscribe(siteId: string, listener: WebScanEventListener, onLost?: () => void): Promise<() => void>;
  close(): Promise<void>;
}

const EVENT_KINDS: readonly WebScanEventKind[] = [
  'progress',
  'queued',
  'running',
  'completed',
  'stopped',
  'failed',
];

const EVENT_STATUSES: readonly WebScanEventStatus[] = [
  'queued',
  'running',
  'completed',
  'stopped',
  'failed',
];

/** One Redis channel per site. */
export function webScanEventsChannel(siteId: string): string {
  return `mergepilot:webscan:${siteId}`;
}

/**
 * Keeps exactly the allowed fields.
 *
 * The counters are clamped to non-negative whole numbers, so a malformed producer can
 * never put a string, a negative number or an object on the wire.
 */
export function toWebScanEventPayload(event: WebScanEvent): WebScanEvent {
  return {
    scanId: event.scanId,
    siteId: event.siteId,
    kind: event.kind,
    status: event.status,
    requests: clampCounter(event.requests),
    pages: clampCounter(event.pages),
    elapsedMs: clampCounter(event.elapsedMs),
  };
}

function clampCounter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Parses a message of the channel; anything malformed is dropped. */
export function parseWebScanEvent(raw: string): WebScanEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['scanId'] !== 'string' || candidate['scanId'].length === 0) return null;
  if (typeof candidate['siteId'] !== 'string' || candidate['siteId'].length === 0) return null;
  if (!EVENT_KINDS.includes(candidate['kind'] as WebScanEventKind)) return null;
  if (!EVENT_STATUSES.includes(candidate['status'] as WebScanEventStatus)) return null;
  return toWebScanEventPayload({
    scanId: candidate['scanId'],
    siteId: candidate['siteId'],
    kind: candidate['kind'] as WebScanEventKind,
    status: candidate['status'] as WebScanEventStatus,
    requests: typeof candidate['requests'] === 'number' ? candidate['requests'] : 0,
    pages: typeof candidate['pages'] === 'number' ? candidate['pages'] : 0,
    elapsedMs: typeof candidate['elapsedMs'] === 'number' ? candidate['elapsedMs'] : 0,
  });
}

/**
 * The in-process bus.
 *
 * The worker and the web server are separate processes, so this bus only carries the
 * events of one process. It is used by the tests and by a single-process deployment.
 */
export class MemoryWebScanEventBus implements WebScanEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: WebScanEvent): void {
    const payload = toWebScanEventPayload(event);
    this.emitter.emit(webScanEventsChannel(payload.siteId), payload);
  }

  async subscribe(siteId: string, listener: WebScanEventListener): Promise<() => void> {
    const channel = webScanEventsChannel(siteId);
    const handler = (event: WebScanEvent) => listener(event);
    this.emitter.on(channel, handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.emitter.off(channel, handler);
    };
  }

  /** The number of listeners of one site's channel. */
  listenerCount(siteId: string): number {
    return this.emitter.listenerCount(webScanEventsChannel(siteId));
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/** The ioredis calls the bus uses; the tests pass fakes. */
export interface WebScanEventsPublisherClient {
  publish(channel: string, message: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** The ioredis calls the subscriber uses; the tests pass fakes. */
export interface WebScanEventsSubscriberClient {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  quit(): Promise<unknown>;
}

/** The options of the Redis bus. */
export interface RedisWebScanEventBusOptions {
  redisUrl?: string | undefined;
  publisher?: WebScanEventsPublisherClient | undefined;
  subscriber?: (() => WebScanEventsSubscriberClient) | undefined;
  /** Error names only: a driver message can carry the connection URL. */
  onError?: ((errorName: string) => void) | undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

function createClient(redisUrl: string, onError: (name: string) => void): Redis {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
  });
  client.on('error', (error: unknown) => onError(errorName(error)));
  return client;
}

/**
 * The scan progress over Redis pub/sub.
 *
 * One subscriber connection per process carries every open stream. A channel is
 * subscribed while at least one listener listens to it and unsubscribed when the last
 * one leaves.
 */
export class RedisWebScanEventBus implements WebScanEventBus {
  private readonly publisher: WebScanEventsPublisherClient;
  private readonly makeSubscriber: () => WebScanEventsSubscriberClient;
  private subscriber: WebScanEventsSubscriberClient | undefined;
  private readonly channelListeners = new Map<string, Set<WebScanEventListener>>();
  private readonly pendingSubscriptions = new Map<string, Promise<unknown>>();
  private readonly lostCallbacks: (() => void)[] = [];
  private readonly onError: (name: string) => void;
  private closed = false;

  constructor(options: RedisWebScanEventBusOptions) {
    this.onError = options.onError ?? (() => {});
    const { redisUrl } = options;
    if (!options.publisher && !redisUrl) {
      throw new Error('RedisWebScanEventBus requires redisUrl or clients');
    }
    this.publisher = options.publisher ?? createClient(redisUrl as string, this.onError);
    this.makeSubscriber =
      options.subscriber ?? (() => createClient(redisUrl as string, this.onError));
  }

  publish(event: WebScanEvent): void {
    if (this.closed) return;
    const payload = toWebScanEventPayload(event);
    this.publisher
      .publish(webScanEventsChannel(payload.siteId), JSON.stringify(payload))
      .catch((error: unknown) => this.onError(errorName(error)));
  }

  async subscribe(
    siteId: string,
    listener: WebScanEventListener,
    onLost?: () => void,
  ): Promise<() => void> {
    if (this.closed) throw new Error('web scan event bus is closed');
    const channel = webScanEventsChannel(siteId);
    const subscriber = this.ensureSubscriber();
    const listeners = this.channelListeners.get(channel) ?? new Set<WebScanEventListener>();
    const first = listeners.size === 0;
    listeners.add(listener);
    this.channelListeners.set(channel, listeners);
    let pending = this.pendingSubscriptions.get(channel);
    if (first) {
      pending = subscriber.subscribe(channel);
      this.pendingSubscriptions.set(channel, pending);
    }
    try {
      await pending;
      if (this.closed) throw new Error('web scan event bus is closed');
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0 && this.channelListeners.get(channel) === listeners) {
        this.channelListeners.delete(channel);
      }
      throw error;
    } finally {
      if (this.pendingSubscriptions.get(channel) === pending) {
        this.pendingSubscriptions.delete(channel);
      }
    }
    if (onLost !== undefined) this.lostCallbacks.push(onLost);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.lostCallbacks.indexOf(onLost as () => void);
      if (index >= 0) this.lostCallbacks.splice(index, 1);
      const current = this.channelListeners.get(channel);
      current?.delete(listener);
      if (current !== undefined && current.size > 0) return;
      this.channelListeners.delete(channel);
      void subscriber.unsubscribe(channel).catch((error: unknown) => {
        this.onError(errorName(error));
      });
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lostCallbacks.length = 0;
    this.channelListeners.clear();
    await Promise.allSettled([
      this.publisher.quit(),
      this.subscriber?.quit() ?? Promise.resolve(),
    ]);
  }

  private ensureSubscriber(): WebScanEventsSubscriberClient {
    if (this.subscriber !== undefined) return this.subscriber;
    const subscriber = this.makeSubscriber();
    // One handler for the whole connection. A handler per subscription would pile up on
    // the connection and every message would be delivered to every listener that ever
    // subscribed.
    subscriber.on('message', (incoming: string, message: string) => {
      const listeners = this.channelListeners.get(incoming);
      if (listeners === undefined) return;
      const event = parseWebScanEvent(message);
      if (event === null) return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A listener that throws must not stop the other listeners.
        }
      }
    });
    subscriber.on('close', () => {
      // The subscriber connection is gone: every open stream may have missed events.
      for (const callback of [...this.lostCallbacks]) {
        try {
          callback();
        } catch {
          // A listener that throws must not stop the other listeners.
        }
      }
    });
    this.subscriber = subscriber;
    return subscriber;
  }
}

import { describe, expect, it } from 'vitest';
import {
  MemoryWebScanEventBus,
  parseWebScanEvent,
  toWebScanEventPayload,
  webScanEventsChannel,
  type WebScanEvent,
} from './events.js';

const event: WebScanEvent = {
  scanId: 'scan-1',
  siteId: 'site-1',
  kind: 'progress',
  status: 'running',
  requests: 12,
  pages: 3,
  elapsedMs: 4_000,
};

describe('the progress event of a scan', () => {
  it('carries only the bounded counters and the ids', () => {
    const payload = toWebScanEventPayload(event);
    expect(Object.keys(payload).sort()).toEqual([
      'elapsedMs',
      'kind',
      'pages',
      'requests',
      'scanId',
      'siteId',
      'status',
    ]);
  });

  it('clamps a counter that is not a whole positive number', () => {
    const payload = toWebScanEventPayload({
      ...event,
      requests: -5,
      pages: 2.7,
      elapsedMs: Number.NaN,
    });
    expect(payload.requests).toBe(0);
    expect(payload.pages).toBe(2);
    expect(payload.elapsedMs).toBe(0);
  });

  it('drops a message that does not carry the allowed fields', () => {
    expect(parseWebScanEvent('not json')).toBeNull();
    expect(parseWebScanEvent('{}')).toBeNull();
    expect(parseWebScanEvent(JSON.stringify({ ...event, kind: 'secret' }))).toBeNull();
    expect(parseWebScanEvent(JSON.stringify({ ...event, status: 'halfway' }))).toBeNull();
    expect(parseWebScanEvent(JSON.stringify({ ...event, scanId: '' }))).toBeNull();
  });

  it('keeps the allowed fields of a well-formed message', () => {
    expect(parseWebScanEvent(JSON.stringify(event))).toEqual(event);
  });
});

describe('the namespace of the scan events', () => {
  it('has a channel of its own, away from the review run channels', () => {
    expect(webScanEventsChannel('site-1')).toBe('mergepilot:webscan:site-1');
    expect(webScanEventsChannel('site-1')).not.toContain('runs');
  });

  it('delivers an event to the listeners of its site only', async () => {
    const bus = new MemoryWebScanEventBus();
    const received: WebScanEvent[] = [];
    const other: WebScanEvent[] = [];
    const unsubscribe = await bus.subscribe('site-1', (incoming) => received.push(incoming));
    await bus.subscribe('site-2', (incoming) => other.push(incoming));

    bus.publish(event);

    expect(received).toEqual([event]);
    expect(other).toEqual([]);

    unsubscribe();
    bus.publish({ ...event, requests: 99 });
    expect(received).toHaveLength(1);
    await bus.close();
  });
});

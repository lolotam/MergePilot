import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { dispatchOutbox } from './outbox.js';
import { scanJobId, type WebScanQueueData } from './queue.js';
import type { WebScanOutboxEntry, WebScanWorkerStore } from './worker-store.js';

/**
 * The durable outbox of the scanner (ADR-0052 section 7).
 *
 * The outbox is the intent, the queue is only the delivery. The job id is the durable
 * scan id, so a retry after a crash produces the same job.
 */

interface FakeQueue {
  queue: Queue<WebScanQueueData>;
  added: { name: string; data: unknown; opts: { jobId?: string } }[];
  existing: Set<string>;
  failWith: Error | null;
}

function fakeQueue(existing: string[] = []): FakeQueue {
  const added: FakeQueue['added'] = [];
  const state: FakeQueue = {
    queue: undefined as unknown as Queue<WebScanQueueData>,
    added,
    existing: new Set(existing),
    failWith: null,
  };
  state.queue = {
    add: async (name: string, data: unknown, opts: { jobId?: string }) => {
      if (state.failWith !== null) throw state.failWith;
      added.push({ name, data, opts });
      return { id: opts.jobId };
    },
    getJob: async (id: string) => (state.existing.has(id) ? { id } : null),
  } as unknown as Queue<WebScanQueueData>;
  return state;
}

function entry(overrides: Partial<WebScanOutboxEntry> = {}): WebScanOutboxEntry {
  return {
    scanId: 'scan-1',
    siteId: 'site-1',
    trigger: 'scheduled',
    scheduledFor: new Date('2026-01-02T01:00:00.000Z'),
    outboxState: 'pending',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function fakeStore(overrides: Partial<WebScanWorkerStore> = {}): WebScanWorkerStore {
  const published: string[] = [];
  const unknown: string[] = [];
  const store = {
    listPendingOutboxScans: vi.fn(async () => [entry()]),
    listPublishedQueuedScans: vi.fn(async () => [] as WebScanOutboxEntry[]),
    markOutboxPublished: vi.fn(async (input: { scanId: string }) => {
      published.push(input.scanId);
      return true;
    }),
    markOutboxUnknown: vi.fn(async (input: { scanId: string }) => {
      unknown.push(input.scanId);
      return true;
    }),
    ...overrides,
  };
  void published;
  void unknown;
  return store as unknown as WebScanWorkerStore;
}

describe('the outbox dispatcher', () => {
  it('publishes an unpublished record under the durable scan id', async () => {
    const q = fakeQueue();
    const store = fakeStore();

    const result = await dispatchOutbox({ store, queue: q.queue });

    expect(q.added).toHaveLength(1);
    expect(q.added[0]?.opts.jobId).toBe(scanJobId('scan-1'));
    expect(q.added[0]?.data).toEqual({ scanId: 'scan-1' });
    expect(store.markOutboxPublished).toHaveBeenCalledWith({
      scanId: 'scan-1',
      now: expect.any(Date),
    });
    expect(result.published).toBe(1);
    expect(result.unknown).toBe(0);
  });

  it('marks a publication whose outcome is unknown instead of failed', async () => {
    const q = fakeQueue();
    q.failWith = new Error('the connection dropped');
    const store = fakeStore();

    const result = await dispatchOutbox({ store, queue: q.queue });

    expect(store.markOutboxUnknown).toHaveBeenCalledWith({
      scanId: 'scan-1',
      now: expect.any(Date),
    });
    expect(store.markOutboxPublished).not.toHaveBeenCalled();
    expect(result.unknown).toBe(1);
    expect(result.published).toBe(0);
  });

  it('publishes a queued scan whose job vanished under the same job id', async () => {
    const q = fakeQueue();
    const store = fakeStore({
      listPendingOutboxScans: vi.fn(async () => []),
      listPublishedQueuedScans: vi.fn(async () => [
        entry({ outboxState: 'published' }),
      ]),
    });

    const result = await dispatchOutbox({ store, queue: q.queue });

    expect(result.recovered).toBe(1);
    expect(q.added).toHaveLength(1);
    expect(q.added[0]?.opts.jobId).toBe(scanJobId('scan-1'));
  });

  it('leaves a queued scan alone while its job is still in the queue', async () => {
    const q = fakeQueue([scanJobId('scan-1')]);
    const store = fakeStore({
      listPendingOutboxScans: vi.fn(async () => []),
      listPublishedQueuedScans: vi.fn(async () => [
        entry({ outboxState: 'published' }),
      ]),
    });

    const result = await dispatchOutbox({ store, queue: q.queue });

    expect(result.recovered).toBe(0);
    expect(q.added).toHaveLength(0);
  });

  it('publishes the same record twice without ever producing two jobs', async () => {
    const q = fakeQueue();
    const store = fakeStore();

    await dispatchOutbox({ store, queue: q.queue });
    await dispatchOutbox({ store, queue: q.queue });

    expect(q.added.map((added) => added.opts.jobId)).toEqual([
      scanJobId('scan-1'),
      scanJobId('scan-1'),
    ]);
  });
});

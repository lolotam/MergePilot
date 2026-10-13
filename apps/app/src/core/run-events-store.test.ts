import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { MemoryRunEventBus, parseRunEvent, runEventsChannel, type RunEvent } from './run-events.js';
import { withRunEvents } from './run-events-store.js';
import { ActiveRunExistsError, type NewReviewRun } from './types.js';

const SECRET_KEY = ['sk', 'live', 'do-not-leak'].join('-');

function newRun(overrides: Partial<NewReviewRun> = {}): NewReviewRun {
  return {
    workspaceId: 'ws-a',
    installationId: 7,
    repoFullName: 'acme/private-repo',
    pullNumber: 12,
    headSha: 'deadbeefcafe',
    status: 'running',
    costUsd: null,
    detail: `token ${SECRET_KEY}`,
    ...overrides,
  };
}

function recorder() {
  const events: RunEvent[] = [];
  return { events, publisher: { publish: (e: RunEvent) => events.push(e) } };
}

describe('withRunEvents (ADR-0021)', () => {
  it('publishes one `created` event per new run, on that run’s workspace', async () => {
    const { events, publisher } = recorder();
    const store = withRunEvents(new MemoryStore(), publisher);

    const run = await store.createReviewRun(newRun());

    expect(events).toEqual([{ workspaceId: 'ws-a', runId: run.id, status: 'running', kind: 'created' }]);
  });

  it('publishes one `updated` event when a run finishes, with the new status', async () => {
    const { events, publisher } = recorder();
    const store = withRunEvents(new MemoryStore(), publisher);
    const run = await store.createReviewRun(newRun());
    events.length = 0;

    await store.finishReviewRun('ws-a', run.id, { status: 'completed', costUsd: 0.1, detail: null });

    expect(events).toEqual([{ workspaceId: 'ws-a', runId: run.id, status: 'completed', kind: 'updated' }]);
  });

  it('publishes one `failed` event when a run fails', async () => {
    const { events, publisher } = recorder();
    const store = withRunEvents(new MemoryStore(), publisher);
    const run = await store.createReviewRun(newRun({ workspaceId: 'ws-b' }));
    events.length = 0;

    await store.finishReviewRun('ws-b', run.id, { status: 'failed', costUsd: null, detail: `provider said ${SECRET_KEY}` });

    expect(events).toEqual([{ workspaceId: 'ws-b', runId: run.id, status: 'failed', kind: 'updated' }]);
  });

  it('publishes one `failed` event per run the stale sweep fails, each on its own workspace', async () => {
    const { events, publisher } = recorder();
    const inner = new MemoryStore();
    const store = withRunEvents(inner, publisher);
    const a = await store.createReviewRun(newRun({ workspaceId: 'ws-a' }));
    const b = await store.createReviewRun(newRun({ workspaceId: 'ws-b', status: 'queued' }));
    events.length = 0;
    const seen: string[] = [];

    const count = await store.failStaleRuns(new Date(Date.now() + 60_000), (refs) => seen.push(...refs.map((r) => r.id)));

    expect(count).toBe(2);
    expect(seen.sort()).toEqual([a.id, b.id].sort());
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { workspaceId: 'ws-a', runId: a.id, status: 'failed', kind: 'updated' },
        { workspaceId: 'ws-b', runId: b.id, status: 'failed', kind: 'updated' },
      ]),
    );
  });

  it('publishes nothing when the store call fails, and nothing on a heartbeat', async () => {
    const { events, publisher } = recorder();
    const store = withRunEvents(new MemoryStore(), publisher);
    const run = await store.createReviewRun(newRun());
    events.length = 0;

    await expect(store.createReviewRun(newRun())).rejects.toBeInstanceOf(ActiveRunExistsError);
    await store.touchReviewRun('ws-a', run.id);

    expect(events).toEqual([]);
  });

  it('carries only ids and status: no repo name, head, detail or key on the wire', async () => {
    const bus = new MemoryRunEventBus();
    const wire: string[] = [];
    await bus.subscribe('ws-a', (e) => wire.push(JSON.stringify(e)));
    const store = withRunEvents(new MemoryStore(), bus);

    const run = await store.createReviewRun(newRun());
    await store.finishReviewRun('ws-a', run.id, { status: 'failed', costUsd: null, detail: `boom ${SECRET_KEY}` });

    expect(wire).toHaveLength(2);
    for (const message of wire) {
      expect(Object.keys(JSON.parse(message) as object).sort()).toEqual(['kind', 'runId', 'status', 'workspaceId']);
      for (const leak of [SECRET_KEY, 'acme', 'private-repo', 'deadbeef', 'boom', 'token']) {
        expect(message).not.toContain(leak);
      }
    }
  });

  it('leaves every other store method working on the real store', async () => {
    const inner = new MemoryStore();
    const store = withRunEvents(inner, recorder().publisher);
    const run = await store.createReviewRun(newRun());

    expect(store).toBeInstanceOf(MemoryStore);
    expect((await store.getReviewRun('ws-a', run.id))?.id).toBe(run.id);
    expect(await store.listReviewRunRepos('ws-a')).toEqual(['acme/private-repo']);
  });
});

describe('MemoryRunEventBus', () => {
  it('delivers a workspace’s events only to that workspace’s listeners, until unsubscribed', async () => {
    const bus = new MemoryRunEventBus();
    const a: RunEvent[] = [];
    const b: RunEvent[] = [];
    const stopA = await bus.subscribe('ws-a', (e) => a.push(e));
    await bus.subscribe('ws-b', (e) => b.push(e));

    bus.publish({ workspaceId: 'ws-a', runId: 'r1', status: 'queued', kind: 'created' });
    stopA();
    stopA();
    bus.publish({ workspaceId: 'ws-a', runId: 'r2', status: 'queued', kind: 'created' });

    expect(a.map((e) => e.runId)).toEqual(['r1']);
    expect(b).toEqual([]);
    expect(bus.listenerCount('ws-a')).toBe(0);
    expect(bus.listenerCount('ws-b')).toBe(1);
  });

  it('strips any extra field a caller passes', async () => {
    const bus = new MemoryRunEventBus();
    const got: RunEvent[] = [];
    await bus.subscribe('ws-a', (e) => got.push(e));
    bus.publish({ workspaceId: 'ws-a', runId: 'r1', status: 'running', kind: 'created', repo: 'x' } as RunEvent);
    expect(got).toEqual([{ workspaceId: 'ws-a', runId: 'r1', status: 'running', kind: 'created' }]);
  });
});

describe('parseRunEvent / runEventsChannel', () => {
  it('names one channel per workspace', () => {
    expect(runEventsChannel('ws-1')).toBe('mergepilot:runs:ws-1');
  });

  it('accepts a well-formed event and drops anything else', () => {
    const ok = { workspaceId: 'w', runId: 'r', status: 'completed', kind: 'updated' };
    expect(parseRunEvent(JSON.stringify({ ...ok, extra: 'x' }))).toEqual(ok);
    expect(parseRunEvent('not json')).toBeNull();
    expect(parseRunEvent('null')).toBeNull();
    expect(parseRunEvent(JSON.stringify({ ...ok, status: 'exploded' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ ...ok, kind: 'deleted' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ ...ok, workspaceId: '' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ ...ok, runId: 5 }))).toBeNull();
  });
});

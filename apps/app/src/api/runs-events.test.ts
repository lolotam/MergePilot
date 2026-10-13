import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRunEventBus } from '../core/run-events.js';
import { MemoryStore } from '../core/memory-store.js';
import { CredentialService } from '../credentials/service.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { registerRunEventsRoutes, type RunStreamLimiter } from './runs-events-routes.js';
import { registerDashboardApi } from './routes.js';
import {
  TOKEN_MEMBER, TOKEN_OTHER, cookieFor, createSseHarness, eventually, listen, openStream, sseConfig,
  type OpenStream, type SseHarness,
} from './runs-events.fixtures.js';

const PATH = '/api/workspaces/ws-1/runs/events';

describe('GET /api/workspaces/:workspaceId/runs/events (ADR-0021)', () => {
  let h: SseHarness;
  let bus: MemoryRunEventBus;
  let limiter: RunStreamLimiter;
  let port: number;
  const streams: OpenStream[] = [];

  beforeEach(async () => {
    h = await createSseHarness();
    bus = new MemoryRunEventBus();
    limiter = registerRunEventsRoutes(h.app, {
      auth: h.auth,
      runEvents: bus,
      runStreams: { perUser: 2, global: 10, keepAliveMs: 60 },
    });
    port = await listen(h.app);
  }, 30_000);

  afterEach(async () => {
    for (const s of streams.splice(0)) s.close();
    await h.app.close();
    await h.pglite.close();
  });

  const open = async (workspaceId = 'ws-1', token = TOKEN_MEMBER) => {
    const s = await openStream(port, workspaceId, cookieFor(token));
    streams.push(s);
    return s;
  };

  it('answers 401 without a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: PATH });
    expect(res.statusCode).toBe(401);
    expect(bus.listenerCount('ws-1')).toBe(0);
  });

  it('answers 403 to a signed-in user who is not a member of the workspace', async () => {
    const res = await h.app.inject({ method: 'GET', url: PATH, headers: { cookie: cookieFor(TOKEN_OTHER) } });
    expect(res.statusCode).toBe(403);
    expect(bus.listenerCount('ws-1')).toBe(0);
    expect(limiter.openStreams()).toBe(0);
  });

  it('streams a member’s workspace events, with the SSE headers, and never another workspace’s', async () => {
    const s = await open();
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toContain('text/event-stream');
    expect(s.headers['cache-control']).toContain('no-cache');
    expect(s.headers['x-accel-buffering']).toBe('no');
    await s.waitFor((t) => t.includes(': connected'));
    expect(s.text()).toContain('retry: 5000');

    bus.publish({ workspaceId: 'ws-2', runId: 'run-of-ws-2', status: 'running', kind: 'created' });
    bus.publish({ workspaceId: 'ws-1', runId: 'run-of-ws-1', status: 'completed', kind: 'updated' });

    const text = await s.waitFor((t) => t.includes('run-of-ws-1'));
    expect(text).toContain('event: run\ndata: {"runId":"run-of-ws-1","status":"completed","kind":"updated"}\n\n');
    expect(text).not.toContain('run-of-ws-2');
  });

  it('lets the other workspace’s member listen to their own workspace only', async () => {
    const mine = await open('ws-2', TOKEN_OTHER);
    expect(mine.status).toBe(200);
    bus.publish({ workspaceId: 'ws-1', runId: 'secret-ws-1-run', status: 'queued', kind: 'created' });
    bus.publish({ workspaceId: 'ws-2', runId: 'own-run', status: 'queued', kind: 'created' });
    const text = await mine.waitFor((t) => t.includes('own-run'));
    expect(text).not.toContain('secret-ws-1-run');
  });

  it('sends a keep-alive comment on the interval', async () => {
    const s = await open();
    await s.waitFor((t) => t.includes(': keep-alive\n\n'));
  });

  it('releases the subscription and the stream slot when the browser disconnects', async () => {
    const s = await open();
    await s.waitFor((t) => t.includes(': connected'));
    expect(bus.listenerCount('ws-1')).toBe(1);
    expect(limiter.openStreams('u-member')).toBe(1);

    s.close();

    await eventually(() => bus.listenerCount('ws-1') === 0 && limiter.openStreams() === 0);
  });

  it('enforces the per-user stream limit and frees a slot when a stream closes', async () => {
    const first = await open();
    const second = await open();
    expect([first.status, second.status]).toEqual([200, 200]);

    const third = await h.app.inject({ method: 'GET', url: PATH, headers: { cookie: cookieFor(TOKEN_MEMBER) } });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: { code: 'too_many_streams', message: 'Too many open live streams for this user' } });
    expect(bus.listenerCount('ws-1')).toBe(2);

    // Another user still has their own slots.
    expect((await open('ws-2', TOKEN_OTHER)).status).toBe(200);

    first.close();
    await eventually(() => limiter.openStreams('u-member') === 1);
    expect((await open()).status).toBe(200);
  });

  it('ends open streams when the server closes, so shutdown does not hang', async () => {
    const s = await open();
    await s.waitFor((t) => t.includes(': connected'));
    await h.app.close();
    expect(bus.listenerCount('ws-1')).toBe(0);
    expect(limiter.openStreams()).toBe(0);
  });
  it('closes a stream after its maximum lifetime, so the browser reconnects through the checks again', async () => {
    await h.app.close();
    h = await createSseHarness();
    bus = new MemoryRunEventBus();
    limiter = registerRunEventsRoutes(h.app, {
      auth: h.auth, runEvents: bus, runStreams: { perUser: 2, global: 10, keepAliveMs: 60_000, maxLifetimeMs: 200 },
    });
    port = await listen(h.app);
    const s = await open();
    expect(s.status).toBe(200);
    await eventually(() => limiter.openStreams() === 0);
    expect(bus.listenerCount('ws-1')).toBe(0);
  });
  it('ends the stream when the bus reports lost delivery, so the browser reconnects and catches up', async () => {
    await h.app.close();
    h = await createSseHarness();
    let lost: (() => void) | undefined;
    const lossyBus = {
      publish: () => {},
      subscribe: async (_ws: string, _listener: unknown, onLost?: () => void) => { lost = onLost; return () => {}; },
      close: async () => {},
    };
    limiter = registerRunEventsRoutes(h.app, { auth: h.auth, runEvents: lossyBus, runStreams: { perUser: 2, global: 10, keepAliveMs: 60_000 } });
    port = await listen(h.app);
    const s = await open();
    expect(s.status).toBe(200);
    expect(limiter.openStreams()).toBe(1);
    lost?.();
    await eventually(() => limiter.openStreams() === 0);
  });
});

describe('runs events route inside the dashboard API', () => {
  let h: SseHarness;

  beforeEach(async () => {
    h = await createSseHarness();
  }, 30_000);

  afterEach(async () => {
    await h.app.close();
    await h.pglite.close();
  });

  const register = (runEvents?: MemoryRunEventBus) => {
    const store = new MemoryStore();
    const credentials = new CredentialService({ store, vault: new EnvelopeVault(Buffer.alloc(32, 1).toString('base64')) });
    registerDashboardApi(h.app, { auth: h.auth, store, credentials, config: sseConfig, runEvents });
  };

  it('is served next to /runs/:runId and streams to a member', async () => {
    const bus = new MemoryRunEventBus();
    register(bus);
    const port = await listen(h.app);
    const s = await openStream(port, 'ws-1', cookieFor(TOKEN_MEMBER));
    try {
      expect(s.status).toBe(200);
      await s.waitFor((t) => t.includes(': connected'));
      bus.publish({ workspaceId: 'ws-1', runId: 'r-1', status: 'queued', kind: 'created' });
      await s.waitFor((t) => t.includes('"runId":"r-1"'));
    } finally {
      s.close();
    }
  });

  it('answers 503 when live updates are not configured', async () => {
    register(undefined);
    await h.app.ready();
    const res = await h.app.inject({ method: 'GET', url: PATH, headers: { cookie: cookieFor(TOKEN_MEMBER) } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'live_updates_unavailable' } });
  });
});

import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth/guard.js';
import type { RunEvent, RunEventBus } from '../core/run-events.js';
import { sendError } from './helpers.js';
import type { Auth } from '../auth/auth.js';

/** Limits of the live runs stream (ADR-0021). */
export interface RunStreamOptions {
  /** Open streams per signed-in user, over all their tabs and workspaces. */
  perUser: number;
  /** Open streams in this web process. */
  global: number;
  /** A comment line this often keeps proxies from closing an idle stream. */
  keepAliveMs: number;
  /** The reconnect delay the browser is told to use (`retry:`). */
  retryMs: number;
  /**
   * A stream is closed after this long; the browser reconnects and passes the session and
   * membership checks again, so a removed member or an ended session stops receiving events.
   */
  maxLifetimeMs: number;
}

export const DEFAULT_RUN_STREAM_OPTIONS: RunStreamOptions = {
  perUser: 5,
  global: 500,
  keepAliveMs: 25_000,
  retryMs: 5_000,
  maxLifetimeMs: 10 * 60_000,
};

export interface RunEventsRouteDeps {
  auth: Auth;
  runEvents?: RunEventBus | undefined;
  runStreams?: Partial<RunStreamOptions> | undefined;
}

/** Counts open streams per user and in total. */
export class RunStreamLimiter {
  private readonly perUserCount = new Map<string, number>();
  private total = 0;

  constructor(private readonly limits: Pick<RunStreamOptions, 'perUser' | 'global'>) {}

  tryAcquire(userId: string): 'ok' | 'user' | 'global' {
    const mine = this.perUserCount.get(userId) ?? 0;
    if (mine >= this.limits.perUser) return 'user';
    if (this.total >= this.limits.global) return 'global';
    this.perUserCount.set(userId, mine + 1);
    this.total += 1;
    return 'ok';
  }

  release(userId: string): void {
    const mine = this.perUserCount.get(userId) ?? 0;
    if (mine <= 0) return;
    if (mine === 1) this.perUserCount.delete(userId);
    else this.perUserCount.set(userId, mine - 1);
    this.total -= 1;
  }

  openStreams(userId?: string): number {
    return userId === undefined ? this.total : (this.perUserCount.get(userId) ?? 0);
  }
}

function sseEvent(event: RunEvent): string {
  return `event: run\ndata: ${JSON.stringify({ runId: event.runId, status: event.status, kind: event.kind })}\n\n`;
}

/**
 * GET /api/workspaces/:workspaceId/runs/events — Server-Sent Events of the workspace's run changes
 * (ADR-0021). Same guard as the runs list: any member can listen, nobody else. Each change is a
 * `run` event carrying only the run id, status and kind; the dashboard refetches its lists.
 */
export function registerRunEventsRoutes(app: FastifyInstance, deps: RunEventsRouteDeps): RunStreamLimiter {
  const options: RunStreamOptions = { ...DEFAULT_RUN_STREAM_OPTIONS, ...deps.runStreams };
  const limiter = new RunStreamLimiter(options);
  const open = new Set<() => void>();

  // Fastify waits for open requests on close; end the streams so shutdown never hangs on them.
  app.addHook('preClose', async () => {
    for (const end of [...open]) end();
  });

  app.get(
    '/api/workspaces/:workspaceId/runs/events',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const bus = deps.runEvents;
      if (!bus) return sendError(reply, 503, 'live_updates_unavailable', 'Live updates are not available');
      const userId = request.auth?.userId ?? '';

      const acquired = limiter.tryAcquire(userId);
      if (acquired !== 'ok') {
        const message = acquired === 'user' ? 'Too many open live streams for this user' : 'Too many open live streams';
        return sendError(reply, 429, 'too_many_streams', message);
      }

      // Filled in as the stream opens; `end` releases whatever exists, once.
      const stream: { raw?: ServerResponse; keepAlive?: ReturnType<typeof setInterval>; lifetime?: ReturnType<typeof setTimeout> } = {};
      let unsubscribe: (() => void) | undefined;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        open.delete(end);
        if (stream.keepAlive) clearInterval(stream.keepAlive);
        if (stream.lifetime) clearTimeout(stream.lifetime);
        unsubscribe?.();
        limiter.release(userId);
        if (stream.raw && !stream.raw.writableEnded) stream.raw.end();
      };

      try {
        unsubscribe = await bus.subscribe(
          workspaceId,
          (event) => {
            if (!ended && event.workspaceId === workspaceId) stream.raw?.write(sseEvent(event));
          },
          // Events may have been missed: end the stream so the browser reconnects and catches up.
          () => end(),
        );
      } catch (err) {
        end();
        request.log.warn(
          { event: 'runs.live_subscribe_failed', errorName: err instanceof Error ? err.name : 'unknown error' },
          'Live runs stream could not subscribe',
        );
        return sendError(reply, 503, 'live_updates_unavailable', 'Live updates are not available');
      }

      // The client may have gone while we subscribed.
      if (reply.raw.destroyed || request.raw.socket?.destroyed) {
        end();
        return reply.hijack();
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        // Keep the security headers the hooks already set (helmet), then the stream's own.
        ...(reply.getHeaders() as OutgoingHttpHeaders),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      raw.write(`retry: ${options.retryMs}\n: connected\n\n`);
      stream.raw = raw;
      open.add(end);
      stream.keepAlive = setInterval(() => raw.write(': keep-alive\n\n'), options.keepAliveMs);
      stream.keepAlive.unref?.();
      stream.lifetime = setTimeout(end, options.maxLifetimeMs);
      stream.lifetime.unref?.();
      // The response's `close` fires when the browser goes (the request's fires once it is read).
      raw.on('close', end);
      raw.on('error', end);
      return reply;
    },
  );

  return limiter;
}

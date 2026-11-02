import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import {
  DEFAULT_RUN_STREAM_OPTIONS,
  RunStreamLimiter,
  type RunStreamOptions,
} from '../api/runs-events-routes.js';
import { extractHeaders, sendError } from '../api/helpers.js';
import { WebScanEventDtoSchema, type WebScanEventDto } from '../api/contract-webscan.js';
import type { Auth } from '../auth/auth.js';
import type { AppConfig } from '../core/config.js';
import { isUserPlatformAdmin } from './guard.js';
import type { WebScanEventBus } from '../webscan/events.js';
import { toWebScanEventPayload } from '../webscan/events.js';
import type { WebScanStore } from '../webscan/store.js';
import {
  parseWebScanParam,
  sendWebScanNotFound,
  webScanAdminId,
  withWebScanErrors,
  type WebScanAdminGuard,
} from './webscan-http.js';

/**
 * The live progress stream of a scan (ADR-0052 section 7).
 *
 * The route follows the live run updates (ADR-0021): the guard runs before any
 * header, the stream is per scan and carries only the bounded counters of that scan,
 * and the browser reconnects when delivery may have been missed. The platform-admin
 * session is re-checked on every keep-alive, so a session that ends or an account
 * that loses its role stops receiving events.
 *
 * The stream options are the run ones with the same names, so one limiter shape
 * serves both routes.
 */

export type WebScanStreamOptionPatch = Partial<RunStreamOptions>;

export interface WebScanEventRouteDeps {
  store: WebScanStore;
  events: WebScanEventBus;
  auth: Auth;
  config: Pick<AppConfig, 'platformAdmins'>;
  streams?: WebScanStreamOptionPatch | undefined;
}

/** One safe progress event, as the wire carries it. */
function sseEvent(event: WebScanEventDto): string {
  return `event: scan\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerWebScanEventRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  deps: WebScanEventRouteDeps,
): RunStreamLimiter {
  const options: RunStreamOptions = { ...DEFAULT_RUN_STREAM_OPTIONS, ...deps.streams };
  const limiter = new RunStreamLimiter(options);
  const open = new Set<() => void>();

  // Fastify waits for open requests on close; end the streams so shutdown never hangs on them.
  app.addHook('preClose', async () => {
    for (const end of [...open]) end();
  });

  app.get(
    '/api/admin/web-scan/scans/:scanId/events',
    { preHandler: [guard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminId = webScanAdminId(request);
      if (adminId === undefined) {
        return sendWebScanNotFound(reply);
      }
      const scanId = parseWebScanParam(request, reply, 'scanId');
      if (typeof scanId !== 'string') return scanId;

      // The scan is looked up before any header is sent: a scan that is not there
      // is a miss, not an empty stream.
      const found = await withWebScanErrors(reply, () => deps.store.getScan(scanId));
      if (!found.ok) return found.reply;
      if (found.value === null) return sendWebScanNotFound(reply);
      const siteId = found.value.siteId;

      const acquired = limiter.tryAcquire(adminId);
      if (acquired !== 'ok') {
        const message =
          acquired === 'user'
            ? 'Too many open live streams for this user'
            : 'Too many open live streams';
        return sendError(reply, 429, 'too_many_streams', message);
      }

      // Filled in as the stream opens; `end` releases whatever exists, once.
      const stream: {
        raw?: ServerResponse;
        keepAlive?: ReturnType<typeof setInterval>;
        lifetime?: ReturnType<typeof setTimeout>;
      } = {};
      let unsubscribe: (() => void) | undefined;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        open.delete(end);
        if (stream.keepAlive) clearInterval(stream.keepAlive);
        if (stream.lifetime) clearTimeout(stream.lifetime);
        unsubscribe?.();
        limiter.release(adminId);
        if (stream.raw && !stream.raw.writableEnded) stream.raw.end();
      };

      // The session is re-checked with the keep-alive, so an ended session or a lost
      // role disconnects the stream instead of feeding it further.
      const recheckAdmin = async () => {
        try {
          const session = await deps.auth.api.getSession({ headers: extractHeaders(request) });
          if (!session?.user || !isUserPlatformAdmin(session.user, deps.config.platformAdmins)) {
            end();
          }
        } catch {
          end();
        }
      };

      try {
        unsubscribe = await deps.events.subscribe(
          siteId,
          (event) => {
            // The stream is this scan's page: events of the other scans of the site
            // and of other sites never reach it.
            if (ended || event.scanId !== scanId) return;
            const payload = WebScanEventDtoSchema.safeParse(toWebScanEventPayload(event));
            if (!payload.success) return;
            stream.raw?.write(sseEvent(payload.data));
          },
          // Events may have been missed: end the stream so the browser reconnects.
          () => end(),
        );
      } catch {
        end();
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
      stream.keepAlive = setInterval(() => {
        raw.write(': keep-alive\n\n');
        void recheckAdmin();
      }, options.keepAliveMs);
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

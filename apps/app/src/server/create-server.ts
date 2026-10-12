import { randomUUID } from 'node:crypto';
import fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyHttpOptions,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import { redactSecrets } from '@mergepilot/engine';
import type { AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type {} from './log-context.js';
import type {} from '../auth/fastify.js';
import type {} from '../admin/guard.js';
import type { AppStore, ReviewQueue } from '../core/types.js';
import { handleWebhook } from '../webhooks/handle.js';
import { firstHeader, webhookOutcomeFields, webhookPayloadFields } from './webhook-log.js';
import { verifyGitHubSignature } from '../webhooks/verify.js';

const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024; // 25 MB (GitHub maximum webhook size)
/** Everything except the webhook (sign-in, dashboard) stays small. */
const DEFAULT_BODY_LIMIT = 1024 * 1024;

function isStaticPath(path: string): boolean {
  return path.startsWith('/assets/') || /\.(js|css|png|svg|ico|woff2|woff|ttf|json|map)$/.test(path);
}

export interface ServerProbes {
  store?: () => Promise<boolean>;
  queue?: () => Promise<boolean>;
}

export interface CreateServerOptions {
  config: AppConfig;
  store: AppStore;
  queue: ReviewQueue;
  log?: FastifyBaseLogger | boolean;
  extraRoutes?: (app: FastifyInstance) => void | Promise<void>;
  probes?: ServerProbes;
}

export function createServer({
  config,
  store,
  queue,
  log,
  extraRoutes,
  probes,
}: CreateServerOptions): FastifyInstance {
  const serverOptions: FastifyHttpOptions<RawServerDefault, FastifyBaseLogger> = {
    bodyLimit: DEFAULT_BODY_LIMIT,
  };

  const isLoggingDisabled = log === false;
  if (isLoggingDisabled) {
    serverOptions.logger = false;
  } else {
    serverOptions.loggerInstance =
      typeof log === 'object' && log !== null ? log : createLogger({ service: 'web' });
    serverOptions.logController = new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'reqId',
    });
    serverOptions.genReqId = (req) => {
      const incoming = req.headers['x-request-id'];
      const val = Array.isArray(incoming) ? incoming[0] : incoming;
      if (typeof val === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(val.trim())) {
        return val.trim();
      }
      return randomUUID();
    };
  }

  const app = fastify(serverOptions);

  if (!isLoggingDisabled) {
    app.addHook('onSend', async (request, reply, payload) => {
      reply.header('x-request-id', request.id);
      if (reply.statusCode >= 400 && reply.statusCode < 500 && typeof payload === 'string') {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          const errObj = parsed?.error as Record<string, unknown> | undefined;
          const c = errObj?.code ?? parsed?.code;
          if (typeof c === 'string') {
            (request as unknown as { _errorCode?: string })._errorCode = c;
          }
        } catch {
          // payload is not json
        }
      }
      return payload;
    });

    app.addHook('onError', async (request, _reply, error) => {
      (request as unknown as { _routeError?: Error })._routeError = error;
    });

    app.addHook('onResponse', async (request, reply) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const statusCode = reply.statusCode;
      const params = request.params as { workspaceId?: string } | undefined;
      const userId = request.logContext?.userId ?? request.auth?.userId ?? request.adminUser?.id;
      const workspaceId =
        request.logContext?.workspaceId ?? request.auth?.workspaceId ?? params?.workspaceId;

      // `reqId` is already bound on request.log by Fastify (requestIdLogLabel).
      const fields = {
        method: request.method,
        route: request.routeOptions?.url ?? path,
        path,
        statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        ...(userId ? { userId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        clientIp: request.ip ?? '',
      };

      const routeError = (request as unknown as { _routeError?: Error & { code?: string } })
        ._routeError;
      if (statusCode >= 500) {
        const err = routeError
          ? {
              type: routeError.name,
              message: redactSecrets(routeError.message).text,
              stack: redactSecrets(routeError.stack ?? '').text,
            }
          : undefined;
        request.log.error({ ...fields, ...(err ? { err } : {}) }, 'request completed');
      } else if (statusCode >= 400) {
        const code =
          (request as unknown as { _errorCode?: string })._errorCode ?? routeError?.code;
        request.log.warn({ ...fields, ...(code ? { code } : {}) }, 'request completed');
      } else if (path === '/health' || isStaticPath(path)) {
        request.log.debug(fields, 'request completed');
      } else {
        request.log.info(fields, 'request completed');
      }
    });
  }

  // Keep raw Buffer for /webhooks/github; parse JSON for other routes
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      const pathname = (req.url ?? '').split('?')[0];
      if (pathname === '/webhooks/github') {
        done(null, body);
        return;
      }

      try {
        const parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // POST /webhooks/github — exactly one 'webhook received' line per delivery, carrying the outcome.
  app.post('/webhooks/github', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
    const event = firstHeader(request.headers['x-github-event']);
    const deliveryId = firstHeader(request.headers['x-github-delivery']);
    const signature = firstHeader(request.headers['x-hub-signature-256']) || undefined;
    const base = { event, deliveryId };

    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from((request.body as string) ?? '', 'utf8');

    // Verify signature first before parsing JSON
    if (!verifyGitHubSignature(rawBody, signature, config.github.webhookSecret)) {
      request.log.warn({ ...base, outcome: 'invalid-signature' }, 'webhook received');
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      request.log.warn({ ...base, outcome: 'invalid-json' }, 'webhook received');
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    // An empty id would be recorded once and then make every later webhook look like a duplicate.
    if (!deliveryId.trim()) {
      request.log.warn({ ...base, outcome: 'missing-delivery-id' }, 'webhook received');
      return reply.status(400).send({ error: 'Missing X-GitHub-Delivery' });
    }

    const result = await handleWebhook(
      { event, deliveryId, payload },
      { store, queue, log: request.log },
    );

    request.log.info(
      { ...base, ...webhookPayloadFields(payload), ...webhookOutcomeFields(result) },
      'webhook received',
    );

    return reply.status(202).send(result);
  });

  // GET /health
  app.get('/health', async (_req, reply) => {
    return reply.status(200).send({ ok: true });
  });

  // GET /ready
  app.get('/ready', async (request, reply) => {
    try {
      const storeReady = probes?.store
        ? await probes.store()
        : 'ready' in store && typeof (store as { ready?: () => Promise<boolean> }).ready === 'function'
          ? await (store as { ready: () => Promise<boolean> }).ready()
          : true;

      const queueReady = probes?.queue
        ? await probes.queue()
        : 'ready' in queue && typeof (queue as { ready?: () => Promise<boolean> }).ready === 'function'
          ? await (queue as { ready: () => Promise<boolean> }).ready()
          : true;

      if (storeReady && queueReady) {
        return reply.status(200).send({ ok: true });
      }

      return reply.status(503).send({
        ok: false,
        services: {
          store: storeReady,
          queue: queueReady,
        },
      });
    } catch (err) {
      request.log.warn({ err }, 'readiness probe failed');
      // Driver errors can carry hosts or connection details; keep the response generic.
      return reply.status(503).send({ ok: false });
    }
  });

  // extraRoutes for other tasks to register auth/dashboard routes
  if (extraRoutes) {
    app.register(async (instance) => {
      await extraRoutes(instance);
    });
  }

  return app;
}

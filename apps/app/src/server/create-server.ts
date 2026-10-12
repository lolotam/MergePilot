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
import type { AppStore, ReviewQueue } from '../core/types.js';
import { handleWebhook } from '../webhooks/handle.js';
import { verifyGitHubSignature } from '../webhooks/verify.js';

const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024; // 25 MB (GitHub maximum webhook size)
/** Everything except the webhook (sign-in, dashboard) stays small. */
const DEFAULT_BODY_LIMIT = 1024 * 1024;

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
      const url = request.url ?? '';
      const path = url.split('?')[0] ?? '';
      const route = request.routeOptions?.url ?? path;
      const reqId = request.id;
      const method = request.method;
      const statusCode = reply.statusCode;
      const durationMs = Math.round(reply.elapsedTime * 100) / 100;
      const clientIp = request.ip ?? '';

      const params = request.params as { workspaceId?: string } | undefined;
      const workspaceId = params?.workspaceId;

      const authReq = request as unknown as {
        auth?: { userId?: string };
        session?: { user?: { id?: string } };
        user?: { id?: string };
      };
      const userId = authReq.auth?.userId ?? authReq.session?.user?.id ?? authReq.user?.id;

      const isStatic =
        path.startsWith('/assets/') ||
        /\.(js|css|png|svg|ico|woff2|woff|ttf|json|map)$/.test(path);
      const isHealth = path === '/health';

      if (statusCode >= 500) {
        const err = (request as unknown as { _routeError?: Error })._routeError;
        request.log.error(
          {
            reqId,
            method,
            route,
            path,
            statusCode,
            durationMs,
            ...(userId ? { userId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            clientIp,
            ...(err
              ? {
                  err: {
                    type: err.name,
                    message: redactSecrets(err.message).text,
                    stack: redactSecrets(err.stack ?? '').text,
                  },
                }
              : {}),
          },
          'request completed',
        );
      } else if (statusCode >= 400) {
        const code =
          (request as unknown as { _errorCode?: string })._errorCode ??
          (request as unknown as { _routeError?: { code?: string } })._routeError?.code;
        request.log.warn(
          {
            reqId,
            method,
            route,
            path,
            statusCode,
            durationMs,
            ...(userId ? { userId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            clientIp,
            ...(code ? { code } : {}),
          },
          'request completed',
        );
      } else if (isHealth || isStatic) {
        request.log.debug(
          {
            reqId,
            method,
            route,
            path,
            statusCode,
            durationMs,
            ...(userId ? { userId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            clientIp,
          },
          'request completed',
        );
      } else {
        request.log.info(
          {
            reqId,
            method,
            route,
            path,
            statusCode,
            durationMs,
            ...(userId ? { userId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            clientIp,
          },
          'request completed',
        );
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

  // POST /webhooks/github
  app.post('/webhooks/github', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
    const rawSignature = request.headers['x-hub-signature-256'];
    const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;

    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from((request.body as string) ?? '', 'utf8');

    // Verify signature first before parsing JSON
    if (!verifyGitHubSignature(rawBody, signature, config.github.webhookSecret)) {
      const rawEvent = request.headers['x-github-event'];
      const event = (Array.isArray(rawEvent) ? rawEvent[0] : rawEvent) ?? '';
      const rawDelivery = request.headers['x-github-delivery'];
      const deliveryId = (Array.isArray(rawDelivery) ? rawDelivery[0] : rawDelivery) ?? '';
      request.log.warn(
        {
          event,
          action: null,
          deliveryId,
          repo: null,
          pr: null,
          outcome: 'invalid-signature',
        },
        'webhook received',
      );
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    const rawEvent = request.headers['x-github-event'];
    const event = (Array.isArray(rawEvent) ? rawEvent[0] : rawEvent) ?? '';

    const rawDelivery = request.headers['x-github-delivery'];
    const deliveryId = (Array.isArray(rawDelivery) ? rawDelivery[0] : rawDelivery) ?? '';
    // An empty id would be recorded once and then make every later webhook look like a duplicate.
    if (!deliveryId.trim()) {
      return reply.status(400).send({ error: 'Missing X-GitHub-Delivery' });
    }

    const payloadObj = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const action = typeof payloadObj.action === 'string' ? payloadObj.action : null;
    const repo = typeof (payloadObj.repository as { full_name?: string } | undefined)?.full_name === 'string'
      ? (payloadObj.repository as { full_name: string }).full_name
      : null;
    const pr = typeof (payloadObj.pull_request as { number?: number } | undefined)?.number === 'number'
      ? (payloadObj.pull_request as { number: number }).number
      : null;

    const result = await handleWebhook(
      { event, deliveryId, payload },
      { store, queue, log: request.log },
    );

    const outcome = result.status === 'enqueued'
      ? 'queued'
      : result.status === 'duplicate'
        ? 'duplicate'
        : 'ignored';

    if (result.status === 'installation_deleted') {
      request.log.info(
        {
          event: 'installation.unlinked',
          installationId: result.installationId,
        },
        'Installation unlinked',
      );
    }

    request.log.info(
      {
        event,
        action,
        deliveryId,
        repo,
        pr,
        outcome,
      },
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

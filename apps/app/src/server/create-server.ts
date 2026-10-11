import fastify, {
  type FastifyBaseLogger,
  type FastifyHttpOptions,
  type FastifyInstance,
  type FastifyRequest,
  type RawServerDefault,
} from 'fastify';
import type { AppConfig } from '../core/config.js';
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

  if (log === false) {
    serverOptions.logger = false;
  } else if (typeof log === 'object' && log !== null) {
    serverOptions.loggerInstance = log;
  } else {
    serverOptions.logger = {
      level: 'info',
      serializers: {
        req(req: FastifyRequest) {
          // Request logging that never logs bodies or headers with secrets
          return {
            method: req.method,
            url: req.url,
            hostname: req.hostname ?? '',
            remoteAddress: req.ip ?? '',
          };
        },
      },
    };
  }

  const app = fastify(serverOptions);

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

    const result = await handleWebhook(
      { event, deliveryId, payload },
      { store, queue, log: request.log },
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

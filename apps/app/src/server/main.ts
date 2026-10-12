import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { registerAdminApi } from '../admin/index.js';
import { registerAuthRoutes } from '../auth/index.js';
import { buildServices, type AppServices } from '../bootstrap/services.js';
import { loadAppConfig, type AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { AppStore, ReviewQueue } from '../core/types.js';
import { createServer, type ServerProbes } from './create-server.js';
import { registerStatic } from './static.js';

export interface ServerInstance {
  app: FastifyInstance;
  config: AppConfig;
  store: AppStore;
  queue: ReviewQueue;
  services: AppServices;
  stop: () => Promise<void>;
}

export type DashboardApiRegistrar = (
  app: FastifyInstance,
  deps?: unknown,
) => Promise<void> | void;

export interface MainOptions {
  env?: Record<string, string | undefined> | undefined;
  storeFactory?: ((databaseUrl: string) => AppStore | Promise<AppStore>) | undefined;
  queueFactory?: ((redisUrl: string) => ReviewQueue | Promise<ReviewQueue>) | undefined;
  services?: AppServices | undefined;
  probes?: ServerProbes | undefined;
  distDir?: string | undefined;
  log?: FastifyBaseLogger | boolean | undefined;
  dashboardApiRegistrar?: DashboardApiRegistrar | undefined;
}

export async function createMainServer(options?: MainOptions): Promise<ServerInstance> {
  const env = options?.env ?? process.env;
  const config = loadAppConfig(env);

  const services =
    options?.services ??
    (await buildServices(config, {
      env,
    }));

  const store = options?.storeFactory
    ? await options.storeFactory(config.databaseUrl)
    : services.store;

  const queue = options?.queueFactory
    ? await options.queueFactory(config.redisUrl)
    : services.queue;

  const defaultStoreProbe = async (): Promise<boolean> => {
    if (config.databaseUrl.startsWith('memory:') || config.databaseUrl === 'memory:') {
      return true;
    }
    try {
      const pool = (
        services as unknown as {
          pool?: { query: (sql: string) => Promise<{ rows: unknown[] }> };
        }
      ).pool;
      if (pool) {
        const res = await pool.query('SELECT 1;');
        return res.rows.length > 0;
      }
      return true;
    } catch {
      return false;
    }
  };

  const defaultQueueProbe = async (): Promise<boolean> => {
    if (config.redisUrl.startsWith('memory:') || config.redisUrl === 'memory:') {
      return true;
    }
    try {
      if ('ready' in queue && typeof (queue as { ready?: () => Promise<boolean> }).ready === 'function') {
        return await (queue as { ready: () => Promise<boolean> }).ready();
      }
      return true;
    } catch {
      return false;
    }
  };

  const probes: ServerProbes = {
    store: options?.probes?.store ?? defaultStoreProbe,
    queue: options?.probes?.queue ?? defaultQueueProbe,
  };

  const app = createServer({
    config,
    store,
    queue,
    log: typeof options?.log !== 'undefined' ? options.log : createLogger({ service: 'web' }),
    probes,
    extraRoutes: async (instance: FastifyInstance) => {
      // 1. @fastify/helmet with CSP
      await instance.register(helmet, {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            imgSrc: [
              "'self'",
              'data:',
              'https://avatars.githubusercontent.com',
              'https://*.githubusercontent.com',
              'https://*.googleusercontent.com',
            ],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'"],
          },
        },
      });

      // 2. @fastify/rate-limit (300/min general, 30/min auth, webhook excluded)
      await instance.register(rateLimit, {
        global: true,
        timeWindow: 60_000,
        max: (req) => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          if (path.startsWith('/api/auth')) {
            return 30;
          }
          return 300;
        },
        keyGenerator: (req) => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          if (path.startsWith('/api/auth')) {
            return `${req.ip}:auth`;
          }
          return req.ip;
        },
        allowList: (req) => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          return path.startsWith('/webhooks');
        },
      });

      // 3. Better Auth routes
      registerAuthRoutes(instance, services.auth);

      // 4. Dashboard API via registerDashboardApi from ../api/index.js
      if (options?.dashboardApiRegistrar) {
        await options.dashboardApiRegistrar(instance, {
          config,
          store,
          auth: services.auth,
          credentials: services.credentials,
          queue,
        });
      } else {
        try {
          const apiPath = '../api/index.js';
          const apiModule: unknown = await (import(apiPath) as Promise<unknown>).catch(() => null);
          if (
            typeof apiModule === 'object' &&
            apiModule !== null &&
            'registerDashboardApi' in apiModule &&
            typeof (apiModule as { registerDashboardApi?: unknown }).registerDashboardApi === 'function'
          ) {
            await (
              apiModule as {
                registerDashboardApi: (a: FastifyInstance, d: unknown) => Promise<void> | void;
              }
            ).registerDashboardApi(instance, {
              config,
              store,
              auth: services.auth,
              credentials: services.credentials,
              queue,
            });
          } else {
            instance.log.warn(
              'Dashboard API module (../api/index.js) not found or registerDashboardApi missing; skipping',
            );
          }
        } catch (err) {
          instance.log.warn({ err }, 'Failed to load dashboard API module; skipping');
        }
      }

      // 4b. Platform Admin API
      registerAdminApi(instance, {
        auth: services.auth,
        db: services.db,
        config,
        store,
      });

      // 5. SPA static files from apps/web/dist
      await registerStatic(instance, { distDir: options?.distDir });
    },
  });

  await app.ready();

  const stop = async () => {
    await app.close();
    await services.close();
  };

  return { app, config, store, queue, services, stop };
}

export async function main(options?: MainOptions): Promise<ServerInstance> {
  const instance = await createMainServer(options);

  const shutdown = async (signal: string) => {
    instance.app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await instance.stop();
      process.exit(0);
    } catch (err) {
      instance.app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  await instance.app.listen({ host: '0.0.0.0', port: instance.config.port });
  return instance;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal error starting server: ${message}\n`);
    process.exit(1);
  });
}

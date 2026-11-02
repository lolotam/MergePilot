import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { registerAdminApi } from '../admin/index.js';
import { registerAuthRoutes } from '../auth/index.js';
import type { Auth } from '../auth/auth.js';
import { buildServices, type AppServices } from '../bootstrap/services.js';
import { loadAppConfig, type AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { MemoryRunEventBus } from '../core/run-events.js';
import { withRunEvents } from '../core/run-events-store.js';
import type { AppStore, ReviewQueue } from '../core/types.js';
import { getUserGitHubAccount } from '../api/helpers.js';
import { createServer, type ServerProbes } from './create-server.js';
import { registerStatic } from './static.js';
import { isEntryPoint } from '../core/entry-point.js';
import { RedisWebScanEventBus, type WebScanEventBus } from '../webscan/events.js';
import { createGitHubTargetApi, isSignablePrivateKey } from '../webscan/github-target-api.js';
import type { WebScanGitHubVerifier } from '../webscan/github-target.js';
import { createGitHubTargetVerifier } from '../webscan/github-target-verify.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import type { WebScanStore } from '../webscan/store.js';

export interface ServerInstance {
  app: FastifyInstance;
  config: AppConfig;
  store: AppStore;
  queue: ReviewQueue;
  services: AppServices;
  /**
   * The website security scanner (ADR-0052).
   *
   * The server never publishes a scan: it writes the durable intent and the worker
   * publishes it. It only reads the ledger and streams the bounded progress events.
   */
  webScan?: WebScanServerRuntime | undefined;
  stop: () => Promise<void>;
}

/** What the server exposes of the website scanner. */
export interface WebScanServerRuntime {
  store: WebScanStore;
  events: WebScanEventBus;
  /**
   * The GitHub boundary of the alert target (ADR-0052 section 8).
   *
   * It is absent when the GitHub App is not configured, and a request that
   * needs a proof from GitHub is then refused.
   */
  github?: WebScanGitHubVerifier | undefined;
}

/**
 * Builds the verifier of the alert target (ADR-0052 section 8).
 *
 * The App needs its id and its private key, and the token of the administrator
 * is read from their own GitHub account. A deployment without a GitHub App has
 * no verifier, and a request that needs one is refused instead of guessed.
 */
function createWebScanGitHubVerifier(
  config: AppConfig,
  auth: Auth,
  log: Pick<FastifyBaseLogger, 'warn'>,
): WebScanGitHubVerifier | undefined {
  const appId = config.github.appId.trim();
  const privateKey = config.github.privateKey.trim();
  if (appId === '' || privateKey === '') return undefined;
  // A key that cannot sign is a configuration error: no verifier, so a request that needs
  // GitHub is refused as unavailable instead of failing every check as "unverifiable".
  if (!isSignablePrivateKey(privateKey)) {
    // The operator has to see why the verifier is missing; the key itself is never logged.
    log.warn(
      { event: 'webscan.github' },
      'The GitHub App private key cannot sign (an RSA PEM is required): the web scan alert target stays unavailable',
    );
    return undefined;
  }

  const api = createGitHubTargetApi({ appId, privateKey });
  const readUserToken = async (userId: string): Promise<string | null> => {
    // The token is a credential: it is used for the GitHub call and never
    // reaches a log, an error or a response.
    const account = await getUserGitHubAccount(auth, userId);
    return account.linked ? account.accessToken : null;
  };
  return createGitHubTargetVerifier({ api, readUserToken });
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

  // Runs created here (retries) reach the live runs table too (ADR-0021).
  const runEvents = services.runEvents ?? new MemoryRunEventBus();
  const store = withRunEvents(
    options?.storeFactory ? await options.storeFactory(config.databaseUrl) : services.store,
    runEvents,
  );

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

  // The website security scanner (ADR-0052). The server only reads the ledger and
  // writes the durable intent of a manual scan; the worker owns the queue. A local
  // in-memory setup has neither the database nor the Redis the scanner needs.
  const serverLog = createLogger({ service: 'web' });
  let webScan: WebScanServerRuntime | undefined;
  const scannerReady =
    services.scannerVault !== undefined &&
    !config.databaseUrl.startsWith('memory:') &&
    !config.redisUrl.startsWith('memory:');
  if (scannerReady && services.scannerVault !== undefined) {
    try {
      webScan = {
        store: new PgWebScanStore(services.db, services.scannerVault),
        events: new RedisWebScanEventBus({
          redisUrl: config.redisUrl,
          onError: (errorName) => {
            serverLog.warn({ event: 'webscan.events', errorName }, 'The web scan event bus failed');
          },
        }),
        github: createWebScanGitHubVerifier(config, services.auth, serverLog),
      };
    } catch (err) {
      serverLog.warn(
        { err },
        'The website scanner is not available on this server; the dashboard will not show it',
      );
    }
  }

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
          runEvents,
          webScan,
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
              runEvents,
              webScan,
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
        webScan,
      });

      // 5. SPA static files from apps/web/dist
      await registerStatic(instance, { distDir: options?.distDir });
    },
  });

  await app.ready();

  const stop = async () => {
    await app.close();
    await webScan?.events.close();
    await services.close();
  };

  return { app, config, store, queue, services, webScan, stop };
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

if (isEntryPoint(import.meta.url)) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal error starting server: ${message}\n`);
    process.exit(1);
  });
}

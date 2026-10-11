import http from 'node:http';
import { App } from '@octokit/app';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { buildServices, type AppServices } from '../bootstrap/services.js';
import { loadAppConfig, type AppConfig } from '../core/config.js';
import type { ReviewJob } from '../core/types.js';
import { createQueueConnection } from '../queue/bullmq-queue.js';
import { wrapOctokit, type OctokitLike } from './octokit-client.js';
import { processReviewJob } from './process-review.js';
import type { GitHubAppClientFactory, ProcessReviewDeps } from './types.js';

export interface ReviewWorkerOptions {
  connection?: ConnectionOptions;
  concurrency?: number;
}

export function createGitHubAppFactory(
  config: { appId: string; privateKey: string; appSlug: string },
  appFactory?: () => App,
): GitHubAppClientFactory {
  const app =
    appFactory !== undefined
      ? appFactory()
      : new App({
          appId: config.appId,
          privateKey: config.privateKey,
        });

  return async (installationId: number) => {
    const octokit = await app.getInstallationOctokit(installationId);
    return {
      client: wrapOctokit(octokit as unknown as OctokitLike),
      publisherLogin: `${config.appSlug}[bot]`,
    };
  };
}

export function startHealthServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/health' || url === '/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, worker: 'running' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      resolve(server);
    });
  });
}

/**
 * Creates a BullMQ worker for the 'reviews' queue with concurrency 2 by default.
 */
export function createReviewWorker(
  deps: ProcessReviewDeps,
  options?: ReviewWorkerOptions,
): Worker<ReviewJob> {
  const concurrency = options?.concurrency ?? 2;
  const connection = options?.connection ?? { host: 'localhost', port: 6379 };

  const worker = new Worker<ReviewJob>(
    'reviews',
    async (job: Job<ReviewJob>) => {
      deps.log?.(`Processing review job ${job.data.deliveryId} for #${job.data.pullNumber}`);
      await processReviewJob(job.data, deps);
    },
    {
      concurrency,
      connection,
    },
  );

  return worker;
}

export interface ProcessSignalTarget {
  on(event: string, handler: () => void | Promise<void>): void;
}

export function attachShutdownHandlers(
  worker: { close: () => Promise<void> },
  processTarget: ProcessSignalTarget = process,
): () => Promise<void> {
  let isClosing = false;

  const shutdown = async () => {
    if (isClosing) return;
    isClosing = true;
    try {
      await worker.close();
    } catch {
      // Ignore errors on closing
    }
  };

  processTarget.on('SIGTERM', shutdown);
  processTarget.on('SIGINT', shutdown);

  return shutdown;
}

export interface WorkerInstance {
  worker: Worker<ReviewJob>;
  services: AppServices;
  healthServer: http.Server;
  config: AppConfig;
  deps: ProcessReviewDeps;
  stop: () => Promise<void>;
}

export interface WorkerOptions {
  env?: Record<string, string | undefined> | undefined;
  services?: AppServices | undefined;
  connection?: ConnectionOptions | undefined;
  githubAppFactory?: GitHubAppClientFactory | undefined;
  log?: ((message: string) => void) | undefined;
}

export async function createWorker(options?: WorkerOptions): Promise<WorkerInstance> {
  const env = options?.env ?? process.env;
  const config = loadAppConfig(env);

  const services = options?.services ?? (await buildServices(config, { env }));

  const githubAppFactory =
    options?.githubAppFactory ??
    createGitHubAppFactory({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      appSlug: config.github.appSlug,
    });

  const deps: ProcessReviewDeps = {
    store: services.store,
    credentials: services.credentials,
    githubAppFactory,
    ...(options?.log ? { log: options.log } : {}),
  };

  const concurrencyStr = env.WORKER_CONCURRENCY?.trim();
  const concurrency = concurrencyStr ? parseInt(concurrencyStr, 10) : 2;

  let connection = options?.connection;
  if (!connection && !config.redisUrl.startsWith('memory:')) {
    connection = createQueueConnection(config.redisUrl);
  }

  const worker = createReviewWorker(deps, {
    concurrency,
    ...(connection ? { connection } : {}),
  });

  const healthPortStr = env.WORKER_HEALTH_PORT?.trim();
  const healthPort = healthPortStr ? parseInt(healthPortStr, 10) : 3001;
  const healthServer = await startHealthServer(healthPort);

  const stop = async () => {
    await Promise.allSettled([
      new Promise<void>((resolve) => healthServer.close(() => resolve())),
      worker.close(),
      services.close(),
    ]);
  };

  return {
    worker,
    services,
    healthServer,
    config,
    deps,
    stop,
  };
}

export async function startWorker(options?: WorkerOptions): Promise<WorkerInstance> {
  const instance = await createWorker(options);

  const shutdown = async (_signal: string) => {
    try {
      await instance.stop();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  return instance;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  startWorker().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal error starting worker: ${message}\n`);
    process.exit(1);
  });
}

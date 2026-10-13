import http from 'node:http';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { buildServices, type AppServices } from '../bootstrap/services.js';
import { loadAppConfig, type AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { PauseCommandJob, ReviewJob } from '../core/types.js';
import { createQueueConnection, PAUSE_COMMAND_JOB_NAME, type QueueJobData } from '../queue/bullmq-queue.js';
import { createGitHubAppFactory } from './github-app-factory.js';
import { processPauseCommandJob } from './process-pause-command.js';
import { processReviewJob } from './process-review.js';
import { startMaintenanceScheduler, type MaintenanceScheduler } from './retention-schedule.js';
import type { GitHubAppClientFactory, ProcessReviewDeps } from './types.js';

/** A queued/running run with no heartbeat for this long is failed as `interrupted`. */
export const STALE_RUN_HEARTBEAT_MS = 15 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Re-exported for existing importers; new code imports './github-app-factory.js' directly.
export { createGitHubAppFactory };

export interface ReviewWorkerOptions {
  connection?: ConnectionOptions;
  concurrency?: number;
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
): Worker<QueueJobData> {
  const concurrency = options?.concurrency ?? 2;
  const connection = options?.connection ?? { host: 'localhost', port: 6379 };

  const worker = new Worker<QueueJobData>(
    'reviews',
    async (job: Job<QueueJobData>) => {
      // Pause/resume commands share the queue under their own job name (ADR-0012).
      if (job.name === PAUSE_COMMAND_JOB_NAME) {
        await processPauseCommandJob(job.data as PauseCommandJob, deps);
        return;
      }
      const reviewJob = job.data as ReviewJob;
      deps.log?.(`Processing review job ${reviewJob.deliveryId} for #${reviewJob.pullNumber}`);
      await processReviewJob(reviewJob, deps);
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
  worker: Worker<QueueJobData>;
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
  logger?: import('pino').Logger | undefined;
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

  const workerLog = options?.logger ?? createLogger({ service: 'worker' });

  const deps: ProcessReviewDeps = {
    store: services.store,
    credentials: services.credentials,
    githubAppFactory,
    logger: workerLog,
    baseUrl: config.baseUrl,
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

  const sweepStale = async () => {
    try {
      // Stale = no heartbeat (updated_at) for STALE_RUN_HEARTBEAT_MS; a live review touches it every 60 s.
      const heartbeatBefore = new Date(Date.now() - STALE_RUN_HEARTBEAT_MS);
      const failedCount = await services.store.failStaleRuns(heartbeatBefore);
      if (failedCount > 0) {
        deps.log?.(`Marked ${failedCount} stale running/queued run(s) as failed (interrupted)`);
      }
      workerLog.info({ event: 'worker.stale_sweep', failedCount }, `Stale run sweep completed: marked ${failedCount} stale run(s) as failed`);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown error';
      deps.log?.(`Failed to sweep stale runs: ${name}`);
      workerLog.error({ event: 'worker.stale_sweep_failed', errorName: name }, `Failed to sweep stale runs: ${name}`);
    }
  };

  // Daily run retention (ADR-0014). Started in the background: a slow Redis must not hold up reviews.
  // `stop()` awaits this promise, so a scheduler that finishes starting during shutdown is closed too.
  const maintenanceStart: Promise<MaintenanceScheduler | undefined> = connection
    ? startMaintenanceScheduler(services.store, connection, workerLog).then(
        (scheduler) => {
          workerLog.info({ event: 'worker.retention_scheduled' }, 'Daily run retention scheduled (03:00 UTC)');
          return scheduler;
        },
        (err: unknown) => {
          const name = err instanceof Error ? err.name : 'unknown error';
          workerLog.error({ event: 'worker.retention_schedule_failed', errorName: name }, `Failed to schedule run retention: ${name}`);
          return undefined;
        },
      )
    : Promise.resolve(undefined);

  await sweepStale();
  const sweepTimer = setInterval(() => {
    void sweepStale();
  }, STALE_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  // Shutdown waits at most 5 s for a scheduler still starting (a hung Redis must not block SIGTERM);
  // one that finishes starting later is closed as soon as it appears. Each scheduler closes once.
  let stopping = false;
  let started: MaintenanceScheduler | undefined;
  // maintenanceStart never rejects (a failed start resolves undefined); a failing close is logged.
  const logCloseError = (err: unknown) => {
    const name = err instanceof Error ? err.name : 'unknown error';
    workerLog.warn({ event: 'worker.retention_close_failed', errorName: name }, `Failed to close run retention: ${name}`);
  };
  const lateClose = maintenanceStart
    .then(async (scheduler) => {
      started = scheduler;
      if (stopping) await scheduler?.close();
    })
    .catch(logCloseError);
  const closeMaintenance = async (): Promise<void> => {
    if (started) {
      await started.close().catch(logCloseError);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([lateClose, new Promise<void>((resolve) => (timer = setTimeout(resolve, 5_000)))]);
    clearTimeout(timer);
  };

  const stop = async () => {
    stopping = true;
    clearInterval(sweepTimer);
    await Promise.allSettled([
      new Promise<void>((resolve) => healthServer.close(() => resolve())),
      worker.close(),
      closeMaintenance(),
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

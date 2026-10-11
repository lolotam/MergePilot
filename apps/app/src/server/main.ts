import type { FastifyInstance } from 'fastify';
import { loadAppConfig, type AppConfig } from '../core/config.js';
import { MemoryStore } from '../core/memory-store.js';
import type { AppStore, ReviewQueue } from '../core/types.js';
import { BullMqReviewQueue } from '../queue/bullmq-queue.js';
import { createServer } from './create-server.js';

export interface ServerInstance {
  app: FastifyInstance;
  config: AppConfig;
  store: AppStore;
  queue: ReviewQueue;
  stop: () => Promise<void>;
}

export interface MainOptions {
  env?: Record<string, string | undefined>;
  storeFactory?: (databaseUrl: string) => AppStore | Promise<AppStore>;
  queueFactory?: (redisUrl: string) => ReviewQueue | Promise<ReviewQueue>;
}

export async function createMainServer(options?: MainOptions): Promise<ServerInstance> {
  const env = options?.env ?? process.env;
  const config = loadAppConfig(env);

  let store: AppStore;
  if (options?.storeFactory) {
    store = await options.storeFactory(config.databaseUrl);
  } else if (config.databaseUrl.startsWith('memory:') || config.databaseUrl === 'memory:') {
    store = new MemoryStore();
  } else {
    throw new Error(
      `Unsupported databaseUrl "${config.databaseUrl}". Use "memory:" for local development or inject a storeFactory.`,
    );
  }

  let queue: ReviewQueue;
  if (options?.queueFactory) {
    queue = await options.queueFactory(config.redisUrl);
  } else if (config.redisUrl.startsWith('memory:') || config.redisUrl === 'memory:') {
    queue = {
      async enqueue() {},
    };
  } else {
    queue = new BullMqReviewQueue({ redisUrl: config.redisUrl });
  }

  const app = createServer({
    config,
    store,
    queue,
    log: true,
  });

  const stop = async () => {
    await app.close();
    if ('close' in queue && typeof (queue as { close?: () => Promise<void> }).close === 'function') {
      await (queue as { close: () => Promise<void> }).close();
    }
  };

  return { app, config, store, queue, stop };
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

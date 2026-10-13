import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { createAuth, type Auth } from '../auth/index.js';
import type { AppConfig } from '../core/config.js';
import { MemoryStore } from '../core/memory-store.js';
import { MemoryRunEventBus, type RunEventBus } from '../core/run-events.js';
import type { AppStore, PauseCommandJob, ReviewJob, ReviewQueue } from '../core/types.js';
import { CredentialService } from '../credentials/index.js';
import { createDb, runMigrations } from '../db/index.js';
import * as dbSchema from '../db/schema.js';
import { BullMqReviewQueue } from '../queue/index.js';
import { RedisRunEventBus } from '../queue/redis-run-events.js';
import { EnvelopeVault } from '../vault/index.js';

export class InMemoryReviewQueue implements ReviewQueue {
  readonly jobs: ReviewJob[] = [];

  readonly commandJobs: PauseCommandJob[] = [];

  async enqueue(job: ReviewJob): Promise<void> {
    this.jobs.push(job);
  }

  async enqueueCommand(job: PauseCommandJob): Promise<void> {
    this.commandJobs.push(job);
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.jobs.length = 0;
    this.commandJobs.length = 0;
  }
}

export interface BuildServicesOptions {
  env?: Record<string, string | undefined> | undefined;
  migrationsDir?: string | undefined;
}

export interface AppServices {
  db: NodePgDatabase<typeof dbSchema> | PgliteDatabase<typeof dbSchema>;
  store: AppStore;
  vault: EnvelopeVault;
  credentials: CredentialService;
  auth: Auth;
  queue: ReviewQueue;
  /** Live run updates (ADR-0021); optional so hand-built test services can leave it out. */
  runEvents?: RunEventBus | undefined;
  close: () => Promise<void>;
}

function buildVault(masterKey: string, env: Record<string, string | undefined>): EnvelopeVault {
  const previousKey = env.MERGEPILOT_MASTER_KEY_PREVIOUS?.trim();
  const versionStr = env.MERGEPILOT_MASTER_KEY_VERSION?.trim();
  const currentVersion = versionStr ? parseInt(versionStr, 10) : previousKey ? 2 : 1;

  if (previousKey) {
    const prevVersion = currentVersion > 1 ? currentVersion - 1 : 1;
    const actualCurrent = currentVersion === prevVersion ? currentVersion + 1 : currentVersion;
    const keys = new Map<number, string>([
      [actualCurrent, masterKey],
      [prevVersion, previousKey],
    ]);
    return new EnvelopeVault({
      current: actualCurrent,
      keys,
    });
  }

  if (versionStr) {
    return new EnvelopeVault({
      masterKey,
      keyVersion: currentVersion,
    });
  }

  return new EnvelopeVault(masterKey);
}

export async function buildServices(
  config: AppConfig,
  options?: BuildServicesOptions,
): Promise<AppServices> {
  const env = options?.env ?? process.env;

  let db: NodePgDatabase<typeof dbSchema> | PgliteDatabase<typeof dbSchema>;
  let store: AppStore;
  let closeDb: () => Promise<void>;

  if (config.databaseUrl.startsWith('memory:') || config.databaseUrl === 'memory:') {
    // Local-dev only: load PGlite lazily so production (which ships without dev dependencies)
    // never imports it.
    const pgliteModule = '@electric-sql/pglite';
    const { PGlite } = (await import(pgliteModule)) as typeof import('@electric-sql/pglite');
    const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');
    const client = new PGlite();
    if (options?.migrationsDir) {
      await runMigrations(client, { migrationsDir: options.migrationsDir });
    }
    db = drizzlePglite(client, { schema: dbSchema });
    store = new MemoryStore();
    closeDb = async () => {
      await client.close();
    };
  } else {
    const dbHandle = createDb(config.databaseUrl);
    await runMigrations(
      dbHandle.pool,
      options?.migrationsDir ? { migrationsDir: options.migrationsDir } : undefined,
    );
    db = dbHandle.db;
    store = dbHandle.store;
    closeDb = async () => {
      await dbHandle.close();
    };
  }

  let queue: ReviewQueue;
  let closeQueue: () => Promise<void>;
  let runEvents: RunEventBus;

  if (config.redisUrl.startsWith('memory:') || config.redisUrl === 'memory:') {
    const memQueue = new InMemoryReviewQueue();
    queue = memQueue;
    closeQueue = async () => {
      await memQueue.close();
    };
    runEvents = new MemoryRunEventBus();
  } else {
    const bullQueue = new BullMqReviewQueue({ redisUrl: config.redisUrl });
    queue = bullQueue;
    closeQueue = async () => {
      await bullQueue.close();
    };
    // Its own publish and subscribe connections, apart from the queue's (ADR-0021).
    runEvents = new RedisRunEventBus({ redisUrl: config.redisUrl });
  }

  const vault = buildVault(config.masterKey, env);
  const credentials = new CredentialService({ store, vault });
  const auth = createAuth({ db, config });

  const close = async () => {
    await Promise.allSettled([closeQueue(), closeDb(), runEvents.close()]);
  };

  return {
    db,
    store,
    vault,
    credentials,
    auth,
    queue,
    runEvents,
    close,
  };
}

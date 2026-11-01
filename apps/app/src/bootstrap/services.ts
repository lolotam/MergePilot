import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { Pool } from 'pg';
import { createAuth, type Auth } from '../auth/index.js';
import type { AppConfig } from '../core/config.js';
import { MemoryStore } from '../core/memory-store.js';
import { MemoryRunEventBus, type RunEventBus } from '../core/run-events.js';
import type { AppStore, CommandJob, ReviewJob, ReviewQueue } from '../core/types.js';
import { CredentialService } from '../credentials/index.js';
import { createDb, runMigrations } from '../db/index.js';
import * as dbSchema from '../db/schema.js';
import { BullMqReviewQueue } from '../queue/index.js';
import { RedisRunEventBus } from '../queue/redis-run-events.js';
import { EnvelopeVault, type EnvelopeVaultOptions } from '../vault/index.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';

export class InMemoryReviewQueue implements ReviewQueue {
  readonly jobs: ReviewJob[] = [];

  readonly commandJobs: CommandJob[] = [];

  async enqueue(job: ReviewJob): Promise<void> {
    this.jobs.push(job);
  }

  async enqueueCommand(job: CommandJob): Promise<void> {
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
  /**
   * The connection pool of the database. The website scanner takes its advisory lease
   * on a dedicated connection of this pool. It is absent for the in-memory database.
   */
  pool?: Pool | undefined;
  /**
   * The purpose-scoped vault of the website scanner (ADR-0052). It shares the master
   * key ring of the provider vault, so a scanner identity key survives a rotation.
   */
  scannerVault?: PurposeScopedVault | undefined;
  close: () => Promise<void>;
}

/**
 * The master key ring of the platform.
 *
 * The provider vault and the purpose-scoped vault of the website scanner are built
 * from the same ring: they wrap different envelopes, but a scanner identity key that
 * was sealed with an older master key must still open after a rotation.
 */
function masterKeyOptions(
  masterKey: string,
  env: Record<string, string | undefined>,
): EnvelopeVaultOptions {
  const previousKey = env.MERGEPILOT_MASTER_KEY_PREVIOUS?.trim();
  const versionStr = env.MERGEPILOT_MASTER_KEY_VERSION?.trim();
  const currentVersion = versionStr ? parseInt(versionStr, 10) : previousKey ? 2 : 1;

  if (previousKey) {
    const prevVersion = currentVersion > 1 ? currentVersion - 1 : 1;
    const actualCurrent = currentVersion === prevVersion ? currentVersion + 1 : currentVersion;
    return {
      current: actualCurrent,
      keys: new Map<number, string>([
        [actualCurrent, masterKey],
        [prevVersion, previousKey],
      ]),
    };
  }

  if (versionStr) {
    return { masterKey, keyVersion: currentVersion };
  }

  return { masterKey };
}

export async function buildServices(
  config: AppConfig,
  options?: BuildServicesOptions,
): Promise<AppServices> {
  const env = options?.env ?? process.env;

  let db: NodePgDatabase<typeof dbSchema> | PgliteDatabase<typeof dbSchema>;
  let store: AppStore;
  let closeDb: () => Promise<void>;
  let pool: Pool | undefined;

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
    pool = dbHandle.pool;
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

  const vaultOptions = masterKeyOptions(config.masterKey, env);
  const vault = new EnvelopeVault(vaultOptions);
  // The scanner vault shares the master key ring of the provider vault.
  const scannerVault = new PurposeScopedVault(vaultOptions);
  const credentials = new CredentialService({ store, vault });
  const auth = createAuth({ db, config });

  const close = async () => {
    await Promise.allSettled([closeQueue(), closeDb(), runEvents.close()]);
  };

  return {
    db,
    store,
    vault,
    scannerVault,
    credentials,
    auth,
    queue,
    runEvents,
    pool,
    close,
  };
}

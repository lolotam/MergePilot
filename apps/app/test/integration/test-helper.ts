import { fileURLToPath } from 'node:url';
import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { PgStore } from '../../src/db/pg-store.js';
import * as schema from '../../src/db/schema.js';

export const INTEGRATION_DATABASE_URL = process.env.INTEGRATION_DATABASE_URL ?? '';
export const INTEGRATION_REDIS_URL = process.env.INTEGRATION_REDIS_URL ?? '';

export const hasIntegrationEnv = Boolean(
  INTEGRATION_DATABASE_URL && INTEGRATION_REDIS_URL,
);

export function getMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

export interface TestSchemaContext {
  schemaName: string;
  connectionString: string;
  pool: Pool;
  close: () => Promise<void>;
}

export async function createTestSchema(databaseUrl: string): Promise<TestSchemaContext> {
  const schemaName = `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rootPool = new Pool({ connectionString: databaseUrl });
  await rootPool.query(`CREATE SCHEMA "${schemaName}";`);

  const sep = databaseUrl.includes('?') ? '&' : '?';
  const scopedConnectionString = `${databaseUrl}${sep}options=-c%20search_path%3D${schemaName},public`;
  const pool = new Pool({ connectionString: scopedConnectionString });

  return {
    schemaName,
    connectionString: scopedConnectionString,
    pool,
    close: async () => {
      await pool.end();
      await rootPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
      await rootPool.end();
    },
  };
}

export interface TestPostgresContext {
  schemaName: string;
  connectionString: string;
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  store: PgStore;
  close: () => Promise<void>;
}

export interface CreateMigratedTestDbOptions {
  /** Organization (workspace) ids to seed so review runs can be recorded for them. */
  workspaces?: readonly string[];
}

export async function createMigratedTestDb(
  databaseUrl: string,
  options?: CreateMigratedTestDbOptions,
): Promise<TestPostgresContext> {
  const schemaCtx = await createTestSchema(databaseUrl);
  await runMigrations(schemaCtx.pool, { migrationsDir: getMigrationsDir() });
  for (const id of options?.workspaces ?? []) {
    await schemaCtx.pool.query('INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3);', [
      id,
      `Workspace ${id}`,
      id,
    ]);
  }

  const db = drizzleNodePg(schemaCtx.pool, { schema });
  const store = new PgStore(db);

  return {
    schemaName: schemaCtx.schemaName,
    connectionString: schemaCtx.connectionString,
    pool: schemaCtx.pool,
    db,
    store,
    close: async () => {
      await schemaCtx.close();
    },
  };
}

export async function clearRedis(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, { lazyConnect: true });
  await redis.connect();
  await redis.flushdb();
  redis.disconnect();
}

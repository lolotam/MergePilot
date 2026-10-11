import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { Pool } from 'pg';
import { runMigrations } from './migrate.js';
import { PgStore } from './pg-store.js';
import * as schema from './schema.js';

export interface DbHandle {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
  store: PgStore;
  close: () => Promise<void>;
}

export interface TestDbHandle {
  db: PgliteDatabase<typeof schema>;
  client: PGlite;
  store: PgStore;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzleNodePg(pool, { schema });
  const store = new PgStore(db);
  return {
    db,
    pool,
    store,
    close: async () => {
      await pool.end();
    },
  };
}

export async function createTestDb(migrationsDir?: string): Promise<TestDbHandle> {
  const client = new PGlite();
  await runMigrations(client, migrationsDir ? { migrationsDir } : undefined);
  const db = drizzlePglite(client, { schema });
  const store = new PgStore(db);
  return {
    db,
    client,
    store,
    close: async () => {
      await client.close();
    },
  };
}

export * from './schema.js';
export * from './migrate.js';
export * from './pg-store.js';

import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PgStore } from './pg-store.js';
import * as schema from './schema.js';

export interface DbHandle {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
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

export * from './schema.js';
export * from './migrate.js';
export * from './pg-store.js';

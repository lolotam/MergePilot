import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { runMigrations } from './migrate.js';
import { PgStore } from './pg-store.js';
import * as schema from './schema.js';

// Test-only: PGlite is a devDependency, so production code must never import this module.

export interface TestDbHandle {
  db: PgliteDatabase<typeof schema>;
  client: PGlite;
  store: PgStore;
  close: () => Promise<void>;
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

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

export interface CreateTestDbOptions {
  /** Organization (workspace) ids to seed so review runs can be recorded for them. */
  workspaces?: readonly string[];
}

export async function createTestDb(
  migrationsDir?: string,
  options?: CreateTestDbOptions,
): Promise<TestDbHandle> {
  const client = new PGlite();
  await runMigrations(client, migrationsDir ? { migrationsDir } : undefined);
  for (const id of options?.workspaces ?? []) {
    await client.query('INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3);', [
      id,
      `Workspace ${id}`,
      id,
    ]);
  }
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

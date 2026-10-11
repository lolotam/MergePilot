import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createTestSchema,
  getMigrationsDir,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
} from './test-helper.js';

describe.skipIf(!hasIntegrationEnv)('migrations integration on real Postgres', () => {
  it('applies 0001 + 0002 on an empty DB, and a second run applies nothing', async () => {
    const schemaCtx = await createTestSchema(INTEGRATION_DATABASE_URL);
    try {
      const migrationsDir = getMigrationsDir();

      const firstRun = await runMigrations(schemaCtx.pool, { migrationsDir });
      expect(firstRun).toEqual(['0001_app.sql', '0002_auth.sql']);

      const dbRows = await schemaCtx.pool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name;',
      );
      expect(dbRows.rows.map((r) => r.name)).toEqual(['0001_app.sql', '0002_auth.sql']);

      const tablesRes = await schemaCtx.pool.query<{ table_name: string }>(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1;',
        [schemaCtx.schemaName],
      );
      const tables = new Set(tablesRes.rows.map((r) => r.table_name));
      expect(tables.has('schema_migrations')).toBe(true);
      expect(tables.has('webhook_deliveries')).toBe(true);
      expect(tables.has('installations')).toBe(true);
      expect(tables.has('workspace_settings')).toBe(true);
      expect(tables.has('provider_credentials')).toBe(true);
      expect(tables.has('review_runs')).toBe(true);
      expect(tables.has('user')).toBe(true);
      expect(tables.has('session')).toBe(true);
      expect(tables.has('account')).toBe(true);

      const secondRun = await runMigrations(schemaCtx.pool, { migrationsDir });
      expect(secondRun).toEqual([]);
    } finally {
      await schemaCtx.close();
    }
  });

  it('two concurrent runs apply once via advisory lock', async () => {
    const schemaCtx = await createTestSchema(INTEGRATION_DATABASE_URL);
    const poolA = new Pool({ connectionString: schemaCtx.connectionString });
    const poolB = new Pool({ connectionString: schemaCtx.connectionString });
    try {
      const migrationsDir = getMigrationsDir();

      const [resA, resB] = await Promise.all([
        runMigrations(poolA, { migrationsDir }),
        runMigrations(poolB, { migrationsDir }),
      ]);

      const combined = [...resA, ...resB].sort();
      expect(combined).toEqual(['0001_app.sql', '0002_auth.sql']);
      expect(resA.length === 0 || resB.length === 0).toBe(true);

      const dbRows = await schemaCtx.pool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name;',
      );
      expect(dbRows.rows.map((r) => r.name)).toEqual(['0001_app.sql', '0002_auth.sql']);
    } finally {
      await poolA.end();
      await poolB.end();
      await schemaCtx.close();
    }
  });
});

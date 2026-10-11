import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from './migrate.js';

describe('runMigrations', { timeout: 20000 }, () => {
  it('applies migrations in filename order and tracks them in schema_migrations', async () => {
    const client = new PGlite();
    try {
      const applied = await runMigrations(client);
      expect(applied.length).toBeGreaterThanOrEqual(1);
      expect(applied).toContain('0001_app.sql');

      // Check schema_migrations table
      const res = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name ASC;',
      );
      expect(res.rows.map((r) => r.name)).toContain('0001_app.sql');
    } finally {
      await client.close();
    }
  });

  it('is idempotent: running twice applies migrations only once', async () => {
    const client = new PGlite();
    try {
      const firstRun = await runMigrations(client);
      expect(firstRun.length).toBeGreaterThanOrEqual(1);

      // Running second time should apply 0 migrations
      const secondRun = await runMigrations(client);
      expect(secondRun).toHaveLength(0);

      const res = await client.query<{ count: string }>(
        'SELECT count(*)::text as count FROM schema_migrations;',
      );
      expect(Number(res.rows[0].count)).toBe(firstRun.length);
    } finally {
      await client.close();
    }
  });

  it('applies multiple migrations in filename order within transactions and rolls back on failure', async () => {
    const client = new PGlite();
    const tempDir = await mkdtemp(join(tmpdir(), 'mp-mig-'));
    try {
      await writeFile(
        join(tempDir, '0001_alpha.sql'),
        'CREATE TABLE test_alpha (id int primary key);',
      );
      await writeFile(
        join(tempDir, '0002_beta.sql'),
        'CREATE TABLE test_beta (id int primary key);',
      );

      const applied = await runMigrations(client, { migrationsDir: tempDir });
      expect(applied).toEqual(['0001_alpha.sql', '0002_beta.sql']);

      // Adding a failing 0003_gamma.sql should roll back and not record in schema_migrations
      await writeFile(
        join(tempDir, '0003_gamma.sql'),
        'CREATE TABLE test_gamma (id int); INVALID SQL SYNTAX HERE;',
      );

      await expect(
        runMigrations(client, { migrationsDir: tempDir }),
      ).rejects.toThrow();

      // Check test_gamma table was rolled back
      const gammaCheck = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'test_gamma') as exists;",
      );
      expect(gammaCheck.rows[0].exists).toBe(false);

      // 0003_gamma.sql is NOT in schema_migrations
      const res = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name ASC;',
      );
      expect(res.rows.map((r) => r.name)).toEqual(['0001_alpha.sql', '0002_beta.sql']);
    } finally {
      await client.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

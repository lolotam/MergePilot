import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M15 = '0015_per_review_usd.sql';

describe('migration 0015_per_review_usd', { timeout: 60000 }, () => {
  it('gives existing settings the default $0.50, accepts $0.50 to $1000, and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0015-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M15) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-1', 'openai', 'gpt-x', 'en');`,
      );

      await copyFile(join(MIGRATIONS, M15), join(dir, M15));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M15]);
      const limit = async () =>
        (await client.query<{ per_review_usd: string }>(`SELECT per_review_usd FROM workspace_settings WHERE workspace_id = 'ws-1';`))
          .rows[0]?.per_review_usd;
      expect(Number(await limit())).toBe(0.5);
      const column = await client.query<{ numeric_precision: number; numeric_scale: number; is_nullable: string; column_default: string }>(
        `SELECT numeric_precision, numeric_scale, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'workspace_settings' AND column_name = 'per_review_usd';`,
      );
      expect(column.rows[0]).toMatchObject({ numeric_precision: 10, numeric_scale: 2, is_nullable: 'NO' });
      expect(Number(column.rows[0]?.column_default)).toBe(0.5);
      await client.query(`INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-new', 'openai', 'gpt-x', 'en');`);
      const fresh = await client.query<{ per_review_usd: string }>(`SELECT per_review_usd FROM workspace_settings WHERE workspace_id = 'ws-new';`);
      expect(Number(fresh.rows[0]?.per_review_usd)).toBe(0.5);

      await client.query(`UPDATE workspace_settings SET per_review_usd = 1000 WHERE workspace_id = 'ws-1';`);
      expect(Number(await limit())).toBe(1000);
      for (const refused of [0, 0.49, 1000.01, null]) {
        await expect(
          client.query(`UPDATE workspace_settings SET per_review_usd = $1 WHERE workspace_id = 'ws-1';`, [refused]),
        ).rejects.toThrow();
      }
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

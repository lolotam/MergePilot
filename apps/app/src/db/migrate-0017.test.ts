import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M17 = '0017_bot_exploration.sql';

describe('migration 0017_bot_exploration', { timeout: 60000 }, () => {
  it('adds exploration flags that default existing and new bots to false and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0017-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M17) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(`INSERT INTO organization (id, name, slug) VALUES ('ws-1', 'Workspace', 'workspace');`);
      await client.exec(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language)
         VALUES ('ws-1', 'anthropic', 'claude-sonnet-5-5', 'en');
         INSERT INTO reviewer_bots (workspace_id, slot, name, logo, provider, model)
         VALUES ('ws-1', 2, 'Owl', 'owl', 'openai', 'gpt-5');`,
      );

      await copyFile(join(MIGRATIONS, M17), join(dir, M17));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M17]);

      const columns = await client.query<{ table_name: string; data_type: string; is_nullable: string; column_default: string }>(
        `SELECT table_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE column_name = 'explore_enabled' AND table_name IN ('workspace_settings', 'reviewer_bots')
         ORDER BY table_name;`,
      );
      expect(columns.rows).toEqual([
        { table_name: 'reviewer_bots', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
        { table_name: 'workspace_settings', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      ]);
      const existing = await client.query<{ main: boolean; extra: boolean }>(
        `SELECT (SELECT explore_enabled FROM workspace_settings WHERE workspace_id = 'ws-1') AS main,
                (SELECT explore_enabled FROM reviewer_bots WHERE workspace_id = 'ws-1' AND slot = 2) AS extra;`,
      );
      expect(existing.rows[0]).toEqual({ main: false, extra: false });

      await client.exec(
        `INSERT INTO organization (id, name, slug) VALUES ('ws-2', 'Other', 'other');
         INSERT INTO workspace_settings (workspace_id, provider, model, language)
         VALUES ('ws-2', 'openai', 'gpt-5', 'en');
         INSERT INTO reviewer_bots (workspace_id, slot, name, logo, provider, model)
         VALUES ('ws-2', 2, 'Fox', 'fox', 'openai', 'gpt-5');`,
      );
      const added = await client.query<{ main: boolean; extra: boolean }>(
        `SELECT (SELECT explore_enabled FROM workspace_settings WHERE workspace_id = 'ws-2') AS main,
                (SELECT explore_enabled FROM reviewer_bots WHERE workspace_id = 'ws-2' AND slot = 2) AS extra;`,
      );
      expect(added.rows[0]).toEqual({ main: false, extra: false });
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

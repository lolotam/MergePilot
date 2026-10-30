import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M18 = '0018_bot_call_timeout.sql';

describe('migration 0018_bot_call_timeout', { timeout: 60000 }, () => {
  it('adds nullable per-bot call timeouts that default existing and new rows to null and are safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0018-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M18) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(`INSERT INTO organization (id, name, slug) VALUES ('ws-1', 'Workspace', 'workspace');`);
      await client.exec(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language)
         VALUES ('ws-1', 'anthropic', 'claude-sonnet-5-5', 'en');
         INSERT INTO reviewer_bots (workspace_id, slot, name, logo, provider, model)
         VALUES ('ws-1', 2, 'Owl', 'owl', 'openai', 'gpt-5');`,
      );
      // Unrelated data the migration must not touch.
      await client.exec(`UPDATE reviewer_bots SET explore_enabled = true WHERE workspace_id = 'ws-1' AND slot = 2;`);

      await copyFile(join(MIGRATIONS, M18), join(dir, M18));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M18]);

      const columns = await client.query<{ table_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT table_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE column_name = 'call_timeout_ms' AND table_name IN ('workspace_settings', 'reviewer_bots')
         ORDER BY table_name;`,
      );
      expect(columns.rows).toEqual([
        { table_name: 'reviewer_bots', data_type: 'integer', is_nullable: 'YES', column_default: null },
        { table_name: 'workspace_settings', data_type: 'integer', is_nullable: 'YES', column_default: null },
      ]);
      const existing = await client.query<{ main: number | null; extra: number | null }>(
        `SELECT (SELECT call_timeout_ms FROM workspace_settings WHERE workspace_id = 'ws-1') AS main,
                (SELECT call_timeout_ms FROM reviewer_bots WHERE workspace_id = 'ws-1' AND slot = 2) AS extra;`,
      );
      expect(existing.rows[0]).toEqual({ main: null, extra: null });

      // An explicit override round-trips in both tables; an explicit null resets to inherit.
      await client.exec(`UPDATE workspace_settings SET call_timeout_ms = 600000 WHERE workspace_id = 'ws-1';`);
      await client.exec(`UPDATE reviewer_bots SET call_timeout_ms = 600000 WHERE workspace_id = 'ws-1' AND slot = 2;`);
      const overridden = await client.query<{ main: number; extra: number }>(
        `SELECT (SELECT call_timeout_ms FROM workspace_settings WHERE workspace_id = 'ws-1') AS main,
                (SELECT call_timeout_ms FROM reviewer_bots WHERE workspace_id = 'ws-1' AND slot = 2) AS extra;`,
      );
      expect(overridden.rows[0]).toEqual({ main: 600000, extra: 600000 });
      await client.exec(`UPDATE workspace_settings SET call_timeout_ms = NULL WHERE workspace_id = 'ws-1';`);
      await client.exec(`UPDATE reviewer_bots SET call_timeout_ms = NULL WHERE workspace_id = 'ws-1' AND slot = 2;`);
      const reset = await client.query<{ main: number | null; extra: number | null }>(
        `SELECT (SELECT call_timeout_ms FROM workspace_settings WHERE workspace_id = 'ws-1') AS main,
                (SELECT call_timeout_ms FROM reviewer_bots WHERE workspace_id = 'ws-1' AND slot = 2) AS extra;`,
      );
      expect(reset.rows[0]).toEqual({ main: null, extra: null });

      // A row created after the migration inherits (null).
      await client.query(`INSERT INTO organization (id, name, slug) VALUES ('ws-2', 'Other', 'other');`);
      await client.exec(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language)
         VALUES ('ws-2', 'openai', 'gpt-5', 'en');
         INSERT INTO reviewer_bots (workspace_id, slot, name, logo, provider, model)
         VALUES ('ws-2', 2, 'Fox', 'fox', 'openai', 'gpt-5');`,
      );
      const added = await client.query<{ main: number | null; extra: number | null }>(
        `SELECT (SELECT call_timeout_ms FROM workspace_settings WHERE workspace_id = 'ws-2') AS main,
                (SELECT call_timeout_ms FROM reviewer_bots WHERE workspace_id = 'ws-2' AND slot = 2) AS extra;`,
      );
      expect(added.rows[0]).toEqual({ main: null, extra: null });

      // Unrelated data (the exploration flag) survives the migration.
      expect(
        (await client.query(`SELECT explore_enabled FROM reviewer_bots WHERE workspace_id = 'ws-1' AND slot = 2`)).rows[0],
      ).toEqual({ explore_enabled: true });

      // Both tables enforce the same bounds; failures must be CHECK violations.
      for (const table of ['workspace_settings', 'reviewer_bots']) {
        for (const invalid of [999, 1200001]) {
          await expect(client.exec(`UPDATE ${table} SET call_timeout_ms = ${invalid} WHERE workspace_id = 'ws-1'`))
            .rejects.toMatchObject({ code: '23514' });
        }
        await client.exec(`UPDATE ${table} SET call_timeout_ms = 1000 WHERE workspace_id = 'ws-1'`);
        await client.exec(`UPDATE ${table} SET call_timeout_ms = 1200000 WHERE workspace_id = 'ws-1'`);
      }

      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
      const afterRerun = await client.query<{ main: number; extra: number }>(
        `SELECT (SELECT call_timeout_ms FROM workspace_settings WHERE workspace_id = 'ws-1') AS main,
                (SELECT call_timeout_ms FROM reviewer_bots WHERE workspace_id = 'ws-1' AND slot = 2) AS extra;`,
      );
      expect(afterRerun.rows[0]).toEqual({ main: 1200000, extra: 1200000 });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

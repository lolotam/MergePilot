import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M10 = '0010_judge_uses.sql';

describe('migration 0010_judge_uses', { timeout: 60000 }, () => {
  it('backfills judge_uses from judge_mode, validates each use and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0010-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M10) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      const modes = { 'ws-off': 'off', 'ws-annotate': 'annotate', 'ws-filter': 'filter' } as const;
      for (const [workspaceId, mode] of Object.entries(modes)) {
        await client.query(
          `INSERT INTO workspace_settings (workspace_id, provider, model, language, judge_enabled, judge_provider, judge_model, judge_mode)
           VALUES ($1, 'anthropic', 'm', 'en', true, 'typesafe', 'jev-latest', $2);`,
          [workspaceId, mode],
        );
      }

      await copyFile(join(MIGRATIONS, M10), join(dir, M10));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M10]);

      const read = async () =>
        Object.fromEntries(
          (
            await client.query<{ workspace_id: string; judge_uses: string[]; judge_mode: string }>(
              `SELECT workspace_id, judge_uses, judge_mode FROM workspace_settings ORDER BY workspace_id;`,
            )
          ).rows.map((r) => [r.workspace_id, { uses: r.judge_uses, mode: r.judge_mode }]),
        );
      // Today's behaviour kept: the duplicate check always ran. judge_mode stays (one release).
      expect(await read()).toEqual({
        'ws-annotate': { uses: ['annotate', 'dedupe'], mode: 'annotate' },
        'ws-filter': { uses: ['filter', 'dedupe'], mode: 'filter' },
        'ws-off': { uses: ['dedupe'], mode: 'off' },
      });

      const update = (set: string) => client.query(`UPDATE workspace_settings SET ${set} WHERE workspace_id = 'ws-off';`);
      await update(`judge_uses = '{}'`);
      // Running the file again changes nothing: an empty set saved after the first run stays empty.
      await client.exec(await readFile(join(MIGRATIONS, M10), 'utf-8'));
      expect((await read())['ws-off']).toEqual({ uses: [], mode: 'off' });

      await update(`judge_uses = '{annotate,filter,dedupe,consensus}'`);
      await expect(update(`judge_uses = '{annotate,loud}'`)).rejects.toThrow();
      await expect(update(`judge_uses = ARRAY[NULL]::text[]`)).rejects.toThrow();
      await expect(update('judge_uses = NULL')).rejects.toThrow();

      // A new row starts with no uses.
      await client.query(`INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-new', 'anthropic', 'm', 'en');`);
      expect((await read())['ws-new']).toEqual({ uses: [], mode: 'off' });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

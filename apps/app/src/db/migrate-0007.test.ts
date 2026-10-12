import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M7 = '0007_judge.sql';

describe('migration 0007_judge', { timeout: 60000 }, () => {
  it('adds the judge columns off by default, validates them and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0007-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M7) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-1', 'anthropic', 'm', 'en');`,
      );

      await copyFile(join(MIGRATIONS, M7), join(dir, M7));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M7]);

      const read = async () =>
        (
          await client.query<Record<string, unknown>>(
            `SELECT judge_enabled, judge_provider, judge_model, judge_mode, judge_threshold::text AS judge_threshold, judge_fallback
             FROM workspace_settings WHERE workspace_id = 'ws-1';`,
          )
        ).rows;
      const defaults = [
        { judge_enabled: false, judge_provider: null, judge_model: null, judge_mode: 'off', judge_threshold: '0.350', judge_fallback: [] },
      ];
      expect(await read()).toEqual(defaults);

      // Running the file again changes nothing (IF NOT EXISTS).
      await client.exec(await readFile(join(MIGRATIONS, M7), 'utf-8'));
      expect(await read()).toEqual(defaults);

      const update = (set: string) => client.query(`UPDATE workspace_settings SET ${set} WHERE workspace_id = 'ws-1';`);
      await update(
        `judge_enabled = true, judge_provider = 'typesafe', judge_model = 'jev-latest', judge_mode = 'filter', judge_threshold = 0.4,
         judge_fallback = '[{"provider":"opencode-zen","model":"jev-1.13-free"}]'::jsonb`,
      );
      await expect(update(`judge_mode = 'loud'`)).rejects.toThrow();
      await expect(update('judge_threshold = 1.5')).rejects.toThrow();
      await expect(update(`judge_fallback = '[1,2,3,4]'::jsonb`)).rejects.toThrow();
      await expect(update(`judge_fallback = '{}'::jsonb`)).rejects.toThrow();
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

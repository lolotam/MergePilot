import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M13 = '0013_max_findings.sql';

describe('migration 0013_max_findings', { timeout: 60000 }, () => {
  it('gives existing settings the limit 5, accepts only the dashboard choices, and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0013-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M13) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-1', 'openai', 'gpt-x', 'en');`,
      );

      await copyFile(join(MIGRATIONS, M13), join(dir, M13));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M13]);
      const limit = async () =>
        (await client.query<{ max_findings: number }>(`SELECT max_findings FROM workspace_settings WHERE workspace_id = 'ws-1';`))
          .rows[0]?.max_findings;
      expect(await limit()).toBe(5);

      await client.query(`UPDATE workspace_settings SET max_findings = 50 WHERE workspace_id = 'ws-1';`);
      expect(await limit()).toBe(50);
      for (const refused of [0, 7, 55]) {
        await expect(
          client.query(`UPDATE workspace_settings SET max_findings = $1 WHERE workspace_id = 'ws-1';`, [refused]),
        ).rejects.toThrow();
      }
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

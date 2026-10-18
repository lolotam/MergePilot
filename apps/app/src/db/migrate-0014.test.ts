import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M14 = '0014_review_skills.sql';
const HASH = 'a'.repeat(64);

describe('migration 0014_review_skills', { timeout: 60000 }, () => {
  it('keeps every bot on Default, binds a skill to its own workspace, and falls back on delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0014-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M14) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      for (const ws of ['ws-1', 'ws-2']) {
        await client.query(
          `INSERT INTO "organization" (id, name, slug) VALUES ($1, $1, $1);`,
          [ws],
        );
        await client.query(
          `INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ($1, 'openai', 'gpt-x', 'en');`,
          [ws],
        );
      }
      await client.query(
        `INSERT INTO reviewer_bots (workspace_id, slot, name, logo, provider, model) VALUES ('ws-1', 2, 'Two', 'owl', 'openai', 'gpt-x');`,
      );

      await copyFile(join(MIGRATIONS, M14), join(dir, M14));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M14]);
      const skillOf = async () =>
        (await client.query<{ skill_id: string | null }>(`SELECT skill_id FROM workspace_settings WHERE workspace_id = 'ws-1';`)).rows[0]?.skill_id;
      expect(await skillOf()).toBeNull();

      const insertSkill = (id: string, ws: string, name: string) =>
        client.query(
          `INSERT INTO review_skills (id, workspace_id, name, content, content_hash, size_tokens, created_by, updated_by)
           VALUES ($1, $2, $3, '# x', $4, 1, 'u', 'u');`,
          [id, ws, name, HASH],
        );
      const own = '00000000-0000-4000-8000-000000000001';
      const foreign = '00000000-0000-4000-8000-000000000002';
      await insertSkill(own, 'ws-1', 'Security');
      await insertSkill(foreign, 'ws-2', 'Other');
      await expect(insertSkill('00000000-0000-4000-8000-000000000003', 'ws-1', 'SECURITY')).rejects.toThrow();

      // A bot can only point at its own workspace's skill.
      await expect(
        client.query(`UPDATE workspace_settings SET skill_id = $1 WHERE workspace_id = 'ws-1';`, [foreign]),
      ).rejects.toThrow();
      await client.query(`UPDATE workspace_settings SET skill_id = $1 WHERE workspace_id = 'ws-1';`, [own]);
      await client.query(`UPDATE reviewer_bots SET skill_id = $1 WHERE workspace_id = 'ws-1' AND slot = 2;`, [own]);

      // Deleting the skill falls the bots back to Default and keeps their workspace.
      await client.query(`DELETE FROM review_skills WHERE id = $1;`, [own]);
      expect(await skillOf()).toBeNull();
      const bot = (await client.query<{ workspace_id: string; skill_id: string | null }>(
        `SELECT workspace_id, skill_id FROM reviewer_bots WHERE slot = 2;`,
      )).rows[0];
      expect(bot).toEqual({ workspace_id: 'ws-1', skill_id: null });

      // Deleting a workspace removes its skills.
      await client.query(`UPDATE workspace_settings SET skill_id = $1 WHERE workspace_id = 'ws-2';`, [foreign]);
      await client.query(`DELETE FROM "organization" WHERE id = 'ws-2';`);
      expect((await client.query(`SELECT id FROM review_skills;`)).rows).toEqual([]);

      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M9 = '0009_reviewer_panel.sql';

const insertRun = (client: PGlite, id: string, status: string, slot?: number) =>
  client.query(
    `INSERT INTO review_runs (id, workspace_id, installation_id, repo_full_name, pull_number, head_sha, status${slot ? ', bot_slot' : ''})
     VALUES ($1, 'ws-1', 7, 'acme/api', 3, 'sha-1', $2${slot ? ', $3' : ''});`,
    slot ? [id, status, slot] : [id, status],
  );

describe('migration 0009_reviewer_panel', { timeout: 60000 }, () => {
  it('moves existing runs and settings to the main bot, scopes the active-run index per bot and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0009-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M9) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(`INSERT INTO organization (id, name, slug) VALUES ('ws-1', 'W1', 'w1');`);
      await client.query(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-1', 'anthropic', 'm', 'en');`,
      );
      await insertRun(client, '00000000-0000-4000-8000-000000000001', 'queued');

      await copyFile(join(MIGRATIONS, M9), join(dir, M9));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M9]);

      // Existing rows belong to the main bot (slot 1) and get the default identity and panel mode.
      const runs = await client.query(`SELECT bot_slot, bot_name FROM review_runs;`);
      expect(runs.rows).toEqual([{ bot_slot: 1, bot_name: null }]);
      const settings = await client.query(
        `SELECT bot_name, bot_logo, panel_mode, panel_min_agreement FROM workspace_settings;`,
      );
      expect(settings.rows).toEqual([{ bot_name: 'MergePilot', bot_logo: 'pilot', panel_mode: 'separate', panel_min_agreement: 1 }]);

      // Running the file again changes nothing.
      await client.exec(await readFile(join(MIGRATIONS, M9), 'utf-8'));

      // One active run per head and bot slot: another slot may run, the same slot may not.
      await insertRun(client, '00000000-0000-4000-8000-000000000002', 'running', 2);
      await expect(insertRun(client, '00000000-0000-4000-8000-000000000003', 'running', 1)).rejects.toThrow(
        /idx_review_runs_active_pr_head/,
      );
      await expect(insertRun(client, '00000000-0000-4000-8000-000000000004', 'queued', 2)).rejects.toThrow();
      await insertRun(client, '00000000-0000-4000-8000-000000000005', 'failed', 2);
      await expect(insertRun(client, '00000000-0000-4000-8000-000000000006', 'failed', 6)).rejects.toThrow();

      // One job runs every bot: a reusable run per job and bot slot, not per job.
      const jobRun = (id: string, sha: string, slot: number) =>
        client.query(
          `INSERT INTO review_runs (id, workspace_id, job_id, installation_id, repo_full_name, pull_number, head_sha, status, bot_slot)
           VALUES ($1, 'ws-1', 'job-9', 7, 'acme/api', 4, $2, 'running', $3);`,
          [id, sha, slot],
        );
      await jobRun('00000000-0000-4000-8000-000000000007', 'sha-9', 1);
      await jobRun('00000000-0000-4000-8000-000000000008', 'sha-9', 3);
      await expect(jobRun('00000000-0000-4000-8000-000000000009', 'sha-10', 3)).rejects.toThrow(
        /idx_review_runs_workspace_job_id_active/,
      );

      const update = (set: string) => client.query(`UPDATE workspace_settings SET ${set} WHERE workspace_id = 'ws-1';`);
      await update(`bot_name = 'Owl', bot_logo = 'owl', panel_mode = 'consensus', panel_min_agreement = 3`);
      await expect(update(`panel_mode = 'vote'`)).rejects.toThrow();
      await expect(update('panel_min_agreement = 6')).rejects.toThrow();
      await expect(update(`bot_name = ''`)).rejects.toThrow();
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps extra bots in slots 2-5 with case-insensitive unique names, removed with their workspace', async () => {
    const client = new PGlite();
    try {
      await runMigrations(client);
      await client.query(`INSERT INTO organization (id, name, slug) VALUES ('ws-1', 'W1', 'w1'), ('ws-2', 'W2', 'w2');`);
      const insertBot = (ws: string, slot: number, name: string, fallback = '[]') =>
        client.query(
          `INSERT INTO reviewer_bots (workspace_id, slot, name, logo, provider, model, fallback)
           VALUES ($1, $2, $3, 'owl', 'openai', 'gpt-5', $4::jsonb);`,
          [ws, slot, name, fallback],
        );

      await insertBot('ws-1', 2, 'Owl');
      const row = await client.query(`SELECT active, effort, fallback FROM reviewer_bots;`);
      expect(row.rows).toEqual([{ active: true, effort: null, fallback: [] }]);
      await expect(insertBot('ws-1', 3, 'OWL')).rejects.toThrow();
      await insertBot('ws-2', 2, 'owl');
      await expect(insertBot('ws-1', 2, 'Fox')).rejects.toThrow();
      await expect(insertBot('ws-1', 1, 'Fox')).rejects.toThrow();
      await expect(insertBot('ws-1', 6, 'Fox')).rejects.toThrow();
      await expect(insertBot('ws-1', 3, 'x'.repeat(41))).rejects.toThrow();
      await expect(insertBot('ws-1', 3, '')).rejects.toThrow();
      await expect(insertBot('ws-1', 3, 'Fox', '[1,2,3,4]')).rejects.toThrow();
      await expect(insertBot('ws-1', 3, 'Fox', '{}')).rejects.toThrow();
      await expect(insertBot('ws-gone', 3, 'Fox')).rejects.toThrow();

      await client.query(`DELETE FROM organization WHERE id = 'ws-1';`);
      const left = await client.query(`SELECT workspace_id FROM reviewer_bots;`);
      expect(left.rows).toEqual([{ workspace_id: 'ws-2' }]);
    } finally {
      await client.close();
    }
  });
});

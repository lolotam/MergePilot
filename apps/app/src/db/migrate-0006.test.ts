import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M6 = '0006_run_retention.sql';

interface UsageRow {
  workspace_id: string;
  month: string;
  runs_total: number;
  runs_completed: number;
  runs_failed: number;
  cost_usd: string;
  input_tokens: string;
  output_tokens: string;
}

async function seedBefore0006(client: PGlite): Promise<void> {
  await client.query(
    `INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-1', 'anthropic', 'm', 'en');`,
  );
  const insert = `INSERT INTO review_runs
    (id, workspace_id, installation_id, repo_full_name, pull_number, head_sha, status, cost_usd, created_at, result)
    VALUES ($1, $2, 1, 'acme/api', $3, $4, $5, $6, $7, $8);`;
  const usage = JSON.stringify({ v: 1, summary: '', highlights: [], findings: [], language: 'en', usage: { inputTokens: 100, outputTokens: 10 } });
  const rows: unknown[][] = [
    ['11111111-1111-4111-8111-111111111111', 'ws-1', 1, 'a', 'completed', '0.5', '2026-08-03T10:00:00Z', usage],
    ['22222222-2222-4222-8222-222222222222', 'ws-1', 2, 'b', 'failed', '0.25', '2026-08-31T23:59:00Z', null],
    ['33333333-3333-4333-8333-333333333333', 'ws-1', 3, 'c', 'skipped', null, '2026-09-01T00:00:00Z', null],
    ['44444444-4444-4444-8444-444444444444', 'ws-1', 4, 'd', 'running', null, '2026-09-02T00:00:00Z', null],
    ['55555555-5555-4555-8555-555555555555', 'ws-2', 5, 'e', 'completed', '1', '2026-09-05T00:00:00Z', usage],
  ];
  for (const row of rows) await client.query(insert, row);
}

describe('migration 0006_run_retention', { timeout: 60000 }, () => {
  it('backfills monthly usage from finished runs, defaults retention to 30 and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0006-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M6) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await seedBefore0006(client);

      await copyFile(join(MIGRATIONS, M6), join(dir, M6));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M6]);

      const settings = await client.query<{ run_retention_days: number | null; repo_colors: unknown }>(
        'SELECT run_retention_days, repo_colors FROM workspace_settings;',
      );
      expect(settings.rows).toEqual([{ run_retention_days: 30, repo_colors: {} }]);

      const read = async () =>
        (
          await client.query<UsageRow>(
            `SELECT workspace_id, to_char(month, 'YYYY-MM-DD') AS month, runs_total, runs_completed, runs_failed,
               cost_usd::text, input_tokens::text, output_tokens::text
             FROM workspace_usage_monthly ORDER BY workspace_id, month;`,
          )
        ).rows;
      const expected = [
        { workspace_id: 'ws-1', month: '2026-08-01', runs_total: 2, runs_completed: 1, runs_failed: 1, cost_usd: '0.750000', input_tokens: '100', output_tokens: '10' },
        { workspace_id: 'ws-1', month: '2026-09-01', runs_total: 1, runs_completed: 0, runs_failed: 0, cost_usd: '0.000000', input_tokens: '0', output_tokens: '0' },
        { workspace_id: 'ws-2', month: '2026-09-01', runs_total: 1, runs_completed: 1, runs_failed: 0, cost_usd: '1.000000', input_tokens: '100', output_tokens: '10' },
      ];
      expect(await read()).toEqual(expected);

      // Running the file again (e.g. by hand) changes nothing: IF NOT EXISTS + ON CONFLICT DO NOTHING.
      await client.exec(await readFile(join(MIGRATIONS, M6), 'utf-8'));
      expect(await read()).toEqual(expected);

      // NULL = forever is allowed; zero or negative days are not.
      await client.query("UPDATE workspace_settings SET run_retention_days = NULL WHERE workspace_id = 'ws-1';");
      await expect(
        client.query("UPDATE workspace_settings SET run_retention_days = 0 WHERE workspace_id = 'ws-1';"),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

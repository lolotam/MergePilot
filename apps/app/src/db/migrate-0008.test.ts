import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M8 = '0008_model_prices.sql';

describe('migration 0008_model_prices', { timeout: 60000 }, () => {
  it('adds the price table and empty overrides, validates them and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0008-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M8) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(
        `INSERT INTO workspace_settings (workspace_id, provider, model, language) VALUES ('ws-1', 'anthropic', 'm', 'en');`,
      );

      await copyFile(join(MIGRATIONS, M8), join(dir, M8));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M8]);

      const overrides = async () =>
        (await client.query<{ price_overrides: unknown }>(`SELECT price_overrides FROM workspace_settings WHERE workspace_id = 'ws-1';`))
          .rows[0]?.price_overrides;
      expect(await overrides()).toEqual([]);

      // Running the file again changes nothing (IF NOT EXISTS).
      await client.exec(await readFile(join(MIGRATIONS, M8), 'utf-8'));
      expect(await overrides()).toEqual([]);

      const insert = (values: string) =>
        client.query(
          `INSERT INTO model_prices (provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, source, fetched_at)
           VALUES ${values};`,
        );
      await insert(`('anthropic', 'claude-x', 3, 15, 0.3, NULL, 'models.dev', now())`);
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT input_per_mtok::text AS i, output_per_mtok::text AS o, cache_read_per_mtok::text AS cr, cache_write_per_mtok AS cw
           FROM model_prices;`,
        )
      ).rows[0];
      expect(row).toEqual({ i: '3.000000', o: '15.000000', cr: '0.300000', cw: null });
      // One row per (provider, model); negative prices and a missing source are refused.
      await expect(insert(`('anthropic', 'claude-x', 1, 1, NULL, NULL, 'models.dev', now())`)).rejects.toThrow();
      await expect(insert(`('anthropic', 'neg', -1, 1, NULL, NULL, 'models.dev', now())`)).rejects.toThrow();
      await expect(insert(`('anthropic', 'nosrc', 1, 1, NULL, NULL, NULL, now())`)).rejects.toThrow();

      const update = (set: string) => client.query(`UPDATE workspace_settings SET ${set} WHERE workspace_id = 'ws-1';`);
      await update(`price_overrides = '[{"provider":"custom","model":"m","inputPerMTok":1,"outputPerMTok":2}]'::jsonb`);
      const tooMany = JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ provider: 'custom', model: `m${i}` })));
      await expect(update(`price_overrides = '${tooMany}'::jsonb`)).rejects.toThrow();
      await expect(update(`price_overrides = '{}'::jsonb`)).rejects.toThrow();
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

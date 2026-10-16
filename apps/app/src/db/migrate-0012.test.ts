import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M12 = '0012_provider_auth_preferences.sql';

describe('migration 0012_provider_auth_preferences', { timeout: 60000 }, () => {
  it('creates provider_auth_preferences and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0012-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file <= M12) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      expect(await runMigrations(client, { migrationsDir: dir })).toContain(M12);
      await client.query(
        `INSERT INTO provider_auth_preferences (workspace_id, provider, default_method)
         VALUES ('ws-1', 'openai', 'subscription');`,
      );
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

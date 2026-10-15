import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M11 = '0011_provider_api_keys.sql';
const GEMINI_ID = '11111111-1111-4111-8111-111111111111';
const ANTHROPIC_ID = '22222222-2222-4222-8222-222222222222';

describe('migration 0011_provider_api_keys', { timeout: 60000 }, () => {
  it('copies an existing gemini key to position 0, leaves other providers, and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0011-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M11) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(
        `INSERT INTO provider_credentials (id, workspace_id, provider, ciphertext, key_version, last4, created_by)
         VALUES ($1, 'ws-1', 'gemini', 'enc::not-the-secret', 1, 'cret', 'user-1'),
                ($2, 'ws-1', 'anthropic', 'enc-anthropic', 1, 'key1', 'user-1');`,
        [GEMINI_ID, ANTHROPIC_ID],
      );

      await copyFile(join(MIGRATIONS, M11), join(dir, M11));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M11]);

      const slots = async () =>
        (
          await client.query<{ provider: string; position: number; ciphertext: string; id: string }>(
            `SELECT id, provider, position, ciphertext FROM provider_api_keys ORDER BY provider, position;`,
          )
        ).rows;
      expect(await slots()).toEqual([
        { id: GEMINI_ID, provider: 'gemini', position: 0, ciphertext: 'enc::not-the-secret' },
      ]);

      await client.exec(await readFile(join(MIGRATIONS, M11), 'utf-8'));
      expect(await slots()).toEqual([
        { id: GEMINI_ID, provider: 'gemini', position: 0, ciphertext: 'enc::not-the-secret' },
      ]);

      await expect(
        client.query(
          `INSERT INTO provider_api_keys (id, workspace_id, provider, position, ciphertext, key_version, last4, created_by)
           VALUES ('33333333-3333-4333-8333-333333333333', 'ws-1', 'gemini', 20, 'enc', 1, 'xxxx', 'user-1');`,
        ),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
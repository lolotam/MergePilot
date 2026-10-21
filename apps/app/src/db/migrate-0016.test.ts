import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M16 = '0016_credential_sign_in_required.sql';
const CRED_ID = '11111111-1111-4111-8111-111111111111';

describe('migration 0016_credential_sign_in_required', { timeout: 60000 }, () => {
  it('adds a nullable sign-in flag to existing credentials and is safe to re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0016-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M16) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(
        `INSERT INTO provider_credentials (id, workspace_id, provider, ciphertext, key_version, last4, created_by)
         VALUES ($1, 'ws-1', 'anthropic', 'enc::not-the-secret', 1, 'cret', 'user-1');`,
        [CRED_ID],
      );

      await copyFile(join(MIGRATIONS, M16), join(dir, M16));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M16]);

      const flagOf = async () =>
        (await client.query<{ sign_in_required_at: string | null }>(
          `SELECT sign_in_required_at FROM provider_credentials WHERE id = $1;`,
          [CRED_ID],
        )).rows[0]?.sign_in_required_at;
      expect(await flagOf()).toBeNull();

      const column = await client.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'provider_credentials' AND column_name = 'sign_in_required_at';`,
      );
      expect(column.rows[0]).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' });

      // The flag holds the instant the provider refused the refresh.
      await client.query(`UPDATE provider_credentials SET sign_in_required_at = now() WHERE id = $1;`, [CRED_ID]);
      expect(await flagOf()).not.toBeNull();

      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

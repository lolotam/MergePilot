import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const M19 = '0019_web_scan.sql';

const SCAN_TABLES = [
  'web_scan_alerts',
  'web_scan_audit',
  'web_scan_exceptions',
  'web_scan_findings',
  'web_scan_occurrences',
  'web_scan_settings',
  'web_scan_sites',
  'web_scans',
];

describe('migration 0019_web_scan', { timeout: 60000 }, () => {
  it('creates the eight platform tables, seeds a paused scanner and refuses to change the audit log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0019-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql') && file < M19) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });
      await client.query(`INSERT INTO organization (id, name, slug) VALUES ('ws-1', 'Workspace', 'workspace');`);

      await copyFile(join(MIGRATIONS, M19), join(dir, M19));
      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([M19]);

      // The eight tables exist and none of them is workspace owned.
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name LIKE 'web_scan%' ORDER BY table_name;`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(SCAN_TABLES);

      const workspaceColumns = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_name LIKE 'web_scan%' AND column_name IN ('workspace_id', 'organization_id')
         ORDER BY table_name;`,
      );
      expect(workspaceColumns.rows).toEqual([]);

      // The seeded settings row: paused, alerts off, no site, no schedule, no approval.
      const settings = await client.query<{
        count: string;
        paused: boolean;
        alerts_enabled: boolean;
        approved_installations: unknown;
        default_schedule: { enabled?: boolean };
      }>(
        `SELECT (SELECT count(*) FROM web_scan_settings) AS count, paused, alerts_enabled,
                approved_installations, default_schedule FROM web_scan_settings;`,
      );
      expect(settings.rows[0]).toEqual({
        count: 1,
        paused: true,
        alerts_enabled: false,
        approved_installations: [],
        default_schedule: { frequency: 'weekly', weekday: 5, hour: 4, minute: 0, enabled: false },
      });

      // No demo site is created by the migration.
      const sites = await client.query<{ count: string }>(`SELECT count(*) FROM web_scan_sites;`);
      expect(sites.rows[0]).toEqual({ count: 0 });

      // The retained coverage of a site lives on the site row, so it outlives the scan
      // snapshot it was produced by. It starts empty.
      const coverageColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'web_scan_sites'
           AND column_name IN ('last_coverage_summary', 'last_coverage_scan_id', 'last_coverage_at')
         ORDER BY column_name;`,
      );
      expect(coverageColumns.rows.map((row) => row.column_name)).toEqual([
        'last_coverage_at',
        'last_coverage_scan_id',
        'last_coverage_summary',
      ]);
      await client.exec(
        `INSERT INTO web_scan_sites (id, hostname, base_url, owner_user_id, identity_key_ciphertext, identity_key_version)
         VALUES ('33333333-3333-4333-8333-333333333333', 'example.com', 'https://example.com', 'admin-1', 's1.z', 1);`,
      );
      const emptyCoverage = await client.query<{
        last_coverage_summary: unknown;
        last_coverage_scan_id: string | null;
        last_coverage_at: Date | null;
      }>(
        `SELECT last_coverage_summary, last_coverage_scan_id, last_coverage_at FROM web_scan_sites
         WHERE id = '33333333-3333-4333-8333-333333333333';`,
      );
      expect(emptyCoverage.rows[0]).toEqual({
        last_coverage_summary: null,
        last_coverage_scan_id: null,
        last_coverage_at: null,
      });
      await client.exec(`DELETE FROM web_scan_sites WHERE id = '33333333-3333-4333-8333-333333333333';`);

      // The settings table holds exactly one row: a second insert fails the check.
      await expect(
        client.exec(
          `INSERT INTO web_scan_settings (id) VALUES ('11111111-1111-4111-8111-111111111111');`,
        ),
      ).rejects.toMatchObject({ code: '23514' });

      // The audit log is append-only at the database level.
      await client.exec(
        `INSERT INTO web_scan_audit (actor, action, target_type, target_id) VALUES ('admin-1', 'site.create', 'site', 'site-1');`,
      );
      await expect(client.exec(`UPDATE web_scan_audit SET actor = 'someone-else';`)).rejects.toThrow(
        /append-only/,
      );
      await expect(client.exec(`DELETE FROM web_scan_audit;`)).rejects.toThrow(/append-only/);
      const audit = await client.query<{ count: string }>(`SELECT count(*) FROM web_scan_audit;`);
      expect(audit.rows[0]).toEqual({ count: 1 });

      expect(await runMigrations(client, { migrationsDir: dir })).toEqual([]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces the hostname, schedule slot, occurrence and idempotency uniqueness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-0019-'));
    const client = new PGlite();
    try {
      for (const file of await readdir(MIGRATIONS)) {
        if (file.endsWith('.sql')) await copyFile(join(MIGRATIONS, file), join(dir, file));
      }
      await runMigrations(client, { migrationsDir: dir });

      await client.exec(
        `INSERT INTO web_scan_sites (id, hostname, base_url, owner_user_id, identity_key_ciphertext, identity_key_version)
         VALUES ('11111111-1111-4111-8111-111111111111', 'example.com', 'https://example.com', 'admin-1', 's1.x', 1);`,
      );

      // The hostname is unique, case insensitively.
      await expect(
        client.exec(
          `INSERT INTO web_scan_sites (id, hostname, base_url, owner_user_id, identity_key_ciphertext, identity_key_version)
           VALUES ('22222222-2222-4222-8222-222222222222', 'EXAMPLE.com', 'https://example.com', 'admin-1', 's1.y', 1);`,
        ),
      ).rejects.toMatchObject({ code: '23505' });

      await client.exec(
        `INSERT INTO web_scans (site_id, trigger, scheduled_for, scope_version, effective_settings)
         VALUES ('11111111-1111-4111-8111-111111111111', 'scheduled', '2026-11-02 04:00:00+00', 1, '{}'::jsonb);`,
      );
      // One scheduled scan per site and slot.
      await expect(
        client.exec(
          `INSERT INTO web_scans (site_id, trigger, scheduled_for, scope_version, effective_settings)
           VALUES ('11111111-1111-4111-8111-111111111111', 'scheduled', '2026-11-02 04:00:00+00', 1, '{}'::jsonb);`,
        ),
      ).rejects.toMatchObject({ code: '23505' });

      // One manual scan per site and idempotency key.
      await client.exec(
        `INSERT INTO web_scans (site_id, trigger, idempotency_key, request_fingerprint, scope_version, effective_settings)
         VALUES ('11111111-1111-4111-8111-111111111111', 'manual', 'key-1', 'fp-1', 1, '{}'::jsonb);`,
      );
      await expect(
        client.exec(
          `INSERT INTO web_scans (site_id, trigger, idempotency_key, request_fingerprint, scope_version, effective_settings)
           VALUES ('11111111-1111-4111-8111-111111111111', 'manual', 'key-1', 'fp-2', 1, '{}'::jsonb);`,
        ),
      ).rejects.toMatchObject({ code: '23505' });

      // A manual scan without an idempotency key is refused by the check constraint.
      await expect(
        client.exec(
          `INSERT INTO web_scans (site_id, trigger, scope_version, effective_settings)
           VALUES ('11111111-1111-4111-8111-111111111111', 'manual', 1, '{}'::jsonb);`,
        ),
      ).rejects.toMatchObject({ code: '23514' });

      // One occurrence per site and occurrence key.
      await client.exec(
        `INSERT INTO web_scan_occurrences (site_id, occurrence_key, target_key, issue_key, check_id, check_version,
            issue_id, subject, severity, validation, confidence, safe_location, evidence_hash, state, last_observed_at)
         VALUES ('11111111-1111-4111-8111-111111111111', 'occ-1', 'target-1', 'issue-1', 'headers', 1,
            'headers/strict-transport-security', 'Strict-Transport-Security', 'medium', 'Likely', 'high',
            'https://example.com/', 'hash-1', 'outstanding', now());`,
      );
      await expect(
        client.exec(
          `INSERT INTO web_scan_occurrences (site_id, occurrence_key, target_key, issue_key, check_id, check_version,
              issue_id, subject, severity, validation, confidence, safe_location, evidence_hash, state, last_observed_at)
           VALUES ('11111111-1111-4111-8111-111111111111', 'occ-1', 'target-1', 'issue-1', 'headers', 1,
              'headers/strict-transport-security', 'Strict-Transport-Security', 'medium', 'Likely', 'high',
              'https://example.com/', 'hash-1', 'outstanding', now());`,
        ),
      ).rejects.toMatchObject({ code: '23505' });

      // An archived occurrence always carries its archive reason.
      await expect(
        client.exec(
          `INSERT INTO web_scan_occurrences (site_id, occurrence_key, target_key, issue_key, check_id, check_version,
              issue_id, subject, severity, validation, confidence, safe_location, evidence_hash, state, last_observed_at)
           VALUES ('11111111-1111-4111-8111-111111111111', 'occ-2', 'target-1', 'issue-1', 'headers', 1,
              'headers/strict-transport-security', 'Strict-Transport-Security', 'medium', 'Likely', 'high',
              'https://example.com/', 'hash-2', 'archived', now());`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

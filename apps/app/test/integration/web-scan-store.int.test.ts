import { randomBytes } from 'node:crypto';
import type { CoverageEntry } from '@mergepilot/webscan';
import { describe, expect, it } from 'vitest';
import { PgWebScanStore } from '../../src/webscan/pg-store.js';
import { defaultScope } from '../../src/webscan/pg-rows.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import {
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
  type TestPostgresContext,
} from './test-helper.js';

/**
 * The locking and constraint behaviour of the scanner store on real Postgres.
 *
 * PGlite cannot show the behaviour that needs more than one connection, so these
 * cases run against a real database: two concurrent writers, the row locks that
 * serialize them and the database guards that refuse a bad write.
 */

if (!hasIntegrationEnv) {
  describe.skip('the web scan store on real Postgres (skipped: no integration env)', () => {
    it.skip('skipped', () => {});
  });
} else {
  const masterKey = randomBytes(32).toString('base64');

  async function fixture(): Promise<{
    context: TestPostgresContext;
    store: PgWebScanStore;
  }> {
    const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
    const store = new PgWebScanStore(context.db, new PurposeScopedVault({ masterKey }));
    return { context, store };
  }

  async function registeredSite(store: PgWebScanStore, hostname = 'example.com') {
    return store.createSite('admin-1', {
      hostname,
      baseUrl: `https://${hostname}`,
      ownerUserId: 'admin-1',
      scope: defaultScope(hostname, `https://${hostname}`),
      authorizedBy: 'admin-1',
    });
  }

  describe('the web scan store on real Postgres', () => {
    it('serializes two concurrent enqueues of the same idempotency key into one scan', async () => {
      const { context, store } = await fixture();
      try {
        await store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(store);

        const results = await Promise.all([
          store.enqueueManualScan('admin-1', { siteId: site.id, idempotencyKey: 'key-1' }),
          store.enqueueManualScan('admin-1', { siteId: site.id, idempotencyKey: 'key-1' }),
        ]);

        const scans = await store.listScans(site.id);
        expect(scans).toHaveLength(1);
        // Exactly one of the two requests created the scan; the other one replayed it.
        expect(results.filter((result) => !result.replayed)).toHaveLength(1);
        expect(results.filter((result) => result.replayed)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    it('serializes two concurrent removals and the site ends up removed once', async () => {
      const { context, store } = await fixture();
      try {
        const site = await registeredSite(store);

        await Promise.all([
          store.removeSite('admin-1', site.id),
          store.removeSite('admin-1', site.id),
        ]);

        const removed = await store.getSite(site.id);
        expect(removed?.removedAt).not.toBeNull();
        expect(removed?.authorization.auditId).toBeNull();

        const audit = await store.listAudit({ targetType: 'site', targetId: site.id });
        expect(audit.filter((entry) => entry.action === 'site.remove')).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    it('refuses to update or delete an audit row under the runtime role', async () => {
      const { context, store } = await fixture();
      try {
        await store.updateSettings('admin-1', { paused: false });
        const audit = await store.listAudit();
        expect(audit.length).toBeGreaterThan(0);

        await expect(
          context.pool.query(`UPDATE web_scan_audit SET actor = 'someone-else';`),
        ).rejects.toThrow(/append-only/);
        await expect(context.pool.query(`DELETE FROM web_scan_audit;`)).rejects.toThrow(/append-only/);

        expect(await store.listAudit()).toHaveLength(audit.length);
      } finally {
        await context.close();
      }
    });

    it('keeps one scan per scheduled slot under two concurrent scheduler runs', async () => {
      const { context, store } = await fixture();
      try {
        await store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(store);
        await store.updateSite('admin-1', site.id, {
          schedule: { frequency: 'daily', hour: 4, minute: 0, enabled: true },
        });

        const slot = new Date('2026-11-02T04:00:00.000Z');
        await Promise.all([
          store.enqueueScheduledScan('scheduler', { siteId: site.id, scheduledFor: slot }),
          store.enqueueScheduledScan('scheduler', { siteId: site.id, scheduledFor: slot }),
        ]);

        expect(await store.listScans(site.id)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    it('refuses a second site row for the same hostname', async () => {
      const { context, store } = await fixture();
      try {
        await registeredSite(store);
        await expect(
          store.createSite('admin-1', {
            hostname: 'EXAMPLE.com',
            baseUrl: 'https://example.com',
            ownerUserId: 'admin-1',
            scope: defaultScope('example.com', 'https://example.com'),
            authorizedBy: 'admin-1',
          }),
        ).rejects.toThrow();

        expect(await store.listSites()).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    it('keeps the coverage of a site after its scan snapshot is deleted', async () => {
      const { context, store } = await fixture();
      try {
        await store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(store);
        const { scan } = await store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-1',
        });
        const coverage: CoverageEntry[] = [
          {
            targetKey: 'target-1',
            checkId: 'headers',
            checkVersion: 1,
            evaluatedIssueIds: ['headers/strict-transport-security'],
            outcome: 'checked',
          },
        ];
        await store.recordScanOutcome('worker', {
          scanId: scan.id,
          siteId: site.id,
          status: 'completed',
          requests: 3,
          pages: 1,
          durationMs: 120,
          findings: [],
          coverage,
          updates: [],
        });

        await context.pool.query(`DELETE FROM web_scans WHERE id = $1;`, [scan.id]);

        const after = await store.getSite(site.id);
        expect(after?.lastCoverage).toEqual(coverage);
        expect(after?.lastCoverageScanId).toBe(scan.id);
      } finally {
        await context.close();
      }
    });

    it('never prunes a tombstone while a resolution is recorded for it', async () => {
      const { context, store } = await fixture();
      try {
        await store.updateSettings('admin-1', { paused: false });
        const site = await registeredSite(store);
        const { scan } = await store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-1',
        });
        const finding = {
          occurrenceKey: 'occ-1',
          targetKey: 'target-1',
          issueKey: 'headers|headers/strict-transport-security|example.com',
          checkId: 'headers',
          checkVersion: 1,
          issueId: 'headers/strict-transport-security',
          subject: 'Strict-Transport-Security',
          severity: 'medium',
          validation: 'Likely',
          confidence: 'high',
          safeLocation: 'https://example.com/',
          evidenceHash: 'hash-1',
          evidence: { header: 'missing' },
          comparison: 'New' as const,
        };
        await store.recordScanOutcome('worker', {
          scanId: scan.id,
          siteId: site.id,
          status: 'completed',
          requests: 3,
          pages: 1,
          durationMs: 120,
          findings: [],
          coverage: [],
          updates: [{ state: 'outstanding', finding }],
        });

        // The horizon elapsed and nobody evaluated the identity, so it is a tombstone.
        await store.updateSettings('admin-1', { retentionDays: 1 });
        await context.pool.query(
          `UPDATE web_scan_occurrences SET last_observed_at = now() - interval '3 days' WHERE site_id = $1;`,
          [site.id],
        );
        expect(await store.archiveUnprovenOccurrences(site.id)).toBe(1);

        // A completed scan proves it fixed, and a resolution is recorded for it at the
        // same time. The tombstone must survive either way.
        const second = await store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-2',
        });
        await store.recordScanOutcome('worker', {
          scanId: second.scan.id,
          siteId: site.id,
          status: 'completed',
          requests: 3,
          pages: 1,
          durationMs: 120,
          findings: [],
          coverage: [],
          updates: [
            {
              state: 'fixed',
              finding: { ...finding, evidence: null, comparison: 'Not checked' as const },
            },
          ],
        });

        // The resolution is recorded first, so it holds the tombstone and the prune
        // leaves it alone. The two forced interleavings of these writers live in
        // web-scan-locks.int.test.ts, where the order of the two is decided by a real
        // row lock instead of by a race.
        await store.createException('admin-1', {
          siteId: site.id,
          occurrenceKey: 'occ-1',
          evidenceHash: 'hash-1',
          kind: 'accepted',
          reasonCategory: 'accepted_risk',
          reason: 'The header is set by the edge proxy.',
        });

        expect(await store.pruneProvenFixedTombstones(site.id)).toBe(0);
        expect(await store.listOccurrences(site.id)).toHaveLength(1);
        expect(await store.listExceptions(site.id)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
  });
}

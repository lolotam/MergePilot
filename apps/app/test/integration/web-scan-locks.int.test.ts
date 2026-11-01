import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../src/db/schema.js';
import { WEB_SCAN_SETTINGS_ID } from '../../src/db/schema.js';
import { PgWebScanStore } from '../../src/webscan/pg-store.js';
import { defaultScope } from '../../src/webscan/pg-rows.js';
import { WebScanNotFoundError } from '../../src/webscan/store.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import {
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
  type TestPostgresContext,
} from './test-helper.js';

/**
 * The lock order and the races of the scanner store on real Postgres.
 *
 * The two findings that are proven here cannot be proven on PGlite, because they need
 * more than one connection:
 *
 *  - the lock order of the scanner tables. Two paths that take the same rows in
 *    different orders can deadlock. The order is settings, site, scan, occurrence,
 *    exception, and the cases below force the two former cycles of the store into
 *    that order and show that both writers finish;
 *  - the resolution of an administrator against the prune of a tombstone. The two
 *    writers want the same row, so the order decides which one wins. The cases below
 *    force the order instead of guessing it.
 *
 * Every case forces the order with a real row lock that is held by a separate
 * connection, and it waits for the blocked writer to be visible in `pg_stat_activity`
 * before it lets go. Nothing here depends on how long a writer takes.
 */

/** The name of the pool of the store under test, so the test can find its sessions. */
const APP_NAME = 'webscan-fix1';

/** How long the test waits for a session to block on a row lock. */
const BLOCK_TIMEOUT_MS = 20_000;

if (!hasIntegrationEnv) {
  describe.skip('the lock order of the scanner on real Postgres (skipped: no integration env)', () => {
    it.skip('skipped', () => {});
  });
} else {
  interface Fixture {
    context: TestPostgresContext;
    store: PgWebScanStore;
    /** The pool of the store under test. Its sessions carry the application name. */
    pool: Pool;
    /** A second pool, used to hold a row lock from the outside. */
    gatePool: Pool;
    close: () => Promise<void>;
  }

  async function fixture(): Promise<Fixture> {
    const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
    const masterKey = randomBytes(32).toString('base64');
    const separator = context.connectionString.includes('?') ? '&' : '?';
    const pool = new Pool({
      connectionString: `${context.connectionString}${separator}application_name=${APP_NAME}`,
    });
    const db = drizzleNodePg(pool, { schema });
    const store = new PgWebScanStore(db, new PurposeScopedVault({ masterKey }));
    const gatePool = new Pool({ connectionString: context.connectionString, max: 4 });
    return {
      context,
      store,
      pool,
      gatePool,
      close: async () => {
        await pool.end();
        await gatePool.end();
        await context.close();
      },
    };
  }

  /**
   * Waits until at least `count` sessions of the store are blocked on a row lock.
   *
   * The state of the sessions is read from the database, not from a timer: the test
   * proceeds only when the lock contention it forced is really there.
   */
  async function waitForBlockedSessions(pool: Pool, count: number): Promise<void> {
    const deadline = Date.now() + BLOCK_TIMEOUT_MS;
    for (;;) {
      const result = await pool.query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked
           FROM pg_stat_activity
          WHERE application_name = $1
            AND state = 'active'
            AND wait_event_type = 'Lock'`,
        [APP_NAME],
      );
      const blocked = result.rows[0]?.blocked ?? 0;
      if (blocked >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`Only ${blocked} of ${count} sessions blocked on a row lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * Holds a row lock from a connection of its own, and hands back the release.
   *
   * The lock is a real row lock of the real table, so the writer that waits for it is
   * really waiting for the row and not for a timer.
   */
  async function holdRowLock(
    gatePool: Pool,
    statement: string,
    params: unknown[],
  ): Promise<() => Promise<void>> {
    const client = await gatePool.connect();
    await client.query('BEGIN');
    await client.query(statement, params);
    return async () => {
      await client.query('COMMIT');
      client.release();
    };
  }

  const FINDING = {
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

  /**
   * A site whose ledger holds one tombstone that a completed scan proved fixed.
   *
   * The tombstone is prunable: it is fixed, it was archived, and no resolution holds
   * it. It is the row the prune wants and the row a resolution wants.
   */
  async function siteWithPrunableTombstone(f: Fixture): Promise<{ siteId: string; occurrenceId: string }> {
    await f.store.updateSettings('admin-1', { paused: false, retentionDays: 1 });
    const site = await f.store.createSite('admin-1', {
      hostname: 'example.com',
      baseUrl: 'https://example.com',
      ownerUserId: 'admin-1',
      scope: defaultScope('example.com', 'https://example.com'),
      authorizedBy: 'admin-1',
    });

    const first = await f.store.enqueueManualScan('admin-1', {
      siteId: site.id,
      idempotencyKey: 'key-1',
    });
    await f.store.recordScanOutcome('worker', {
      scanId: first.scan.id,
      siteId: site.id,
      status: 'completed',
      requests: 3,
      pages: 1,
      durationMs: 120,
      findings: [],
      coverage: [],
      updates: [{ state: 'outstanding', finding: FINDING }],
    });

    // The horizon elapses and nobody evaluated the identity, so it becomes a
    // tombstone.
    await f.context.pool.query(
      `UPDATE web_scan_occurrences SET last_observed_at = now() - interval '3 days' WHERE site_id = $1;`,
      [site.id],
    );
    expect(await f.store.archiveUnprovenOccurrences(site.id)).toBe(1);

    // A completed scan proves it fixed, so the tombstone becomes prunable.
    const second = await f.store.enqueueManualScan('admin-1', {
      siteId: site.id,
      idempotencyKey: 'key-2',
    });
    await f.store.recordScanOutcome('worker', {
      scanId: second.scan.id,
      siteId: site.id,
      status: 'completed',
      requests: 3,
      pages: 1,
      durationMs: 120,
      findings: [],
      coverage: [],
      updates: [{ state: 'fixed', finding: { ...FINDING, evidence: null, comparison: 'Not checked' } }],
    });

    const occurrences = await f.store.listOccurrences(site.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.state).toBe('fixed');
    return { siteId: site.id, occurrenceId: occurrences[0]!.id };
  }

  describe('the resolution of an administrator against the prune of a tombstone', () => {
    it('keeps the tombstone when the resolution comes first', async () => {
      const f = await fixture();
      let release: (() => Promise<void>) | null = null;
      try {
        const { siteId, occurrenceId } = await siteWithPrunableTombstone(f);

        // The row is held from the outside, so the resolution is the second writer
        // that wants it and the first one that gets it.
        release = await holdRowLock(
          f.gatePool,
          'SELECT id FROM web_scan_occurrences WHERE id = $1 FOR UPDATE',
          [occurrenceId],
        );
        const pending = f.store.createException('admin-1', {
          siteId,
          occurrenceKey: 'occ-1',
          evidenceHash: 'hash-1',
          kind: 'accepted',
          reasonCategory: 'accepted_risk',
          reason: 'The header is set by the edge proxy.',
        });
        await waitForBlockedSessions(f.pool, 1);
        await release();
        release = null;

        const exception = await pending;
        expect(exception.id).toBeTruthy();

        // The resolution holds the tombstone, so the prune leaves it alone.
        expect(await f.store.pruneProvenFixedTombstones(siteId)).toBe(0);
        expect(await f.store.listOccurrences(siteId)).toHaveLength(1);
        expect(await f.store.listExceptions(siteId)).toHaveLength(1);
      } finally {
        if (release !== null) await release();
        await f.close();
      }
    });

    it('refuses a resolution of a tombstone the prune already took', async () => {
      const f = await fixture();
      let release: (() => Promise<void>) | null = null;
      try {
        const { siteId, occurrenceId } = await siteWithPrunableTombstone(f);

        // The same row, the other way around: the prune is the second writer that
        // wants it and the first one that gets it.
        release = await holdRowLock(
          f.gatePool,
          'SELECT id FROM web_scan_occurrences WHERE id = $1 FOR UPDATE',
          [occurrenceId],
        );
        const pending = f.store.pruneProvenFixedTombstones(siteId);
        await waitForBlockedSessions(f.pool, 1);
        await release();
        release = null;

        expect(await pending).toBe(1);
        expect(await f.store.listOccurrences(siteId)).toHaveLength(0);

        // The identity is gone, so a resolution of it is refused instead of pointing
        // at a row that is not there any more.
        await expect(
          f.store.createException('admin-1', {
            siteId,
            occurrenceKey: 'occ-1',
            evidenceHash: 'hash-1',
            kind: 'accepted',
            reasonCategory: 'accepted_risk',
            reason: 'The header is set by the edge proxy.',
          }),
        ).rejects.toBeInstanceOf(WebScanNotFoundError);
        expect(await f.store.listExceptions(siteId)).toHaveLength(0);
      } finally {
        if (release !== null) await release();
        await f.close();
      }
    });
  });

  describe('the lock order of the scanner tables', () => {
    it('never deadlocks the archive of the ledger against the enqueue of a scan', async () => {
      const f = await fixture();
      let release: (() => Promise<void>) | null = null;
      try {
        await f.store.updateSettings('admin-1', { paused: false });
        const site = await f.store.createSite('admin-1', {
          hostname: 'example.com',
          baseUrl: 'https://example.com',
          ownerUserId: 'admin-1',
          scope: defaultScope('example.com', 'https://example.com'),
          authorizedBy: 'admin-1',
        });

        // Both writers want the settings row, and the site row under it. The order
        // of the two tables is what keeps them apart.
        release = await holdRowLock(
          f.gatePool,
          'SELECT id FROM web_scan_settings WHERE id = $1 FOR UPDATE',
          [WEB_SCAN_SETTINGS_ID],
        );
        const enqueue = f.store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-1',
        });
        await waitForBlockedSessions(f.pool, 1);
        const archive = f.store.archiveUnprovenOccurrences(site.id);
        await waitForBlockedSessions(f.pool, 2);
        await release();
        release = null;

        const [enqueued, archived] = await Promise.all([enqueue, archive]);
        expect(enqueued.replayed).toBe(false);
        expect(archived).toBe(0);
        expect(await f.store.listScans(site.id)).toHaveLength(1);
      } finally {
        if (release !== null) await release();
        await f.close();
      }
    });

    it('never deadlocks the archive of the ledger against the terminal write of a scan', async () => {
      const f = await fixture();
      let release: (() => Promise<void>) | null = null;
      try {
        await f.store.updateSettings('admin-1', { paused: false });
        const site = await f.store.createSite('admin-1', {
          hostname: 'example.com',
          baseUrl: 'https://example.com',
          ownerUserId: 'admin-1',
          scope: defaultScope('example.com', 'https://example.com'),
          authorizedBy: 'admin-1',
        });
        const { scan } = await f.store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-1',
        });
        await f.store.recordScanOutcome('worker', {
          scanId: scan.id,
          siteId: site.id,
          status: 'completed',
          requests: 3,
          pages: 1,
          durationMs: 120,
          findings: [],
          coverage: [],
          updates: [{ state: 'outstanding', finding: FINDING }],
        });

        const occurrences = await f.store.listOccurrences(site.id);
        const occurrenceId = occurrences[0]!.id;
        const queued = await f.store.enqueueManualScan('admin-1', {
          siteId: site.id,
          idempotencyKey: 'key-2',
        });

        // The terminal write wants the ledger row, and the site row is under it.
        release = await holdRowLock(
          f.gatePool,
          'SELECT id FROM web_scan_occurrences WHERE id = $1 FOR UPDATE',
          [occurrenceId],
        );
        const outcome = f.store.recordScanOutcome('worker', {
          scanId: queued.scan.id,
          siteId: site.id,
          status: 'completed',
          requests: 3,
          pages: 1,
          durationMs: 120,
          findings: [],
          coverage: [],
          updates: [{ state: 'outstanding', finding: FINDING }],
        });
        await waitForBlockedSessions(f.pool, 1);
        const archive = f.store.archiveUnprovenOccurrences(site.id);
        await waitForBlockedSessions(f.pool, 2);
        await release();
        release = null;

        await Promise.all([outcome, archive]);
        expect((await f.store.getScan(queued.scan.id))?.status).toBe('completed');
      } finally {
        if (release !== null) await release();
        await f.close();
      }
    });
  });
}

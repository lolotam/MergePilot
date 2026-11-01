import { randomBytes } from 'node:crypto';
import type { Comparison } from '@mergepilot/webscan';
import { createTestDb, type TestDbHandle } from '../db/test-db.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { PgWebScanStore } from './pg-store.js';
import { defaultScope } from './pg-rows.js';

/**
 * The shared fixtures of the web scan store tests.
 *
 * The tests of the store are split over several files, so the fixtures they need live
 * here instead of in one of the test files.
 */

const masterKey = randomBytes(32).toString('base64');

/** A store over a fresh PGlite database. */
export async function fixture(): Promise<{ db: TestDbHandle; store: PgWebScanStore }> {
  const db = await createTestDb();
  const store = new PgWebScanStore(db.db, new PurposeScopedVault({ masterKey }));
  return { db, store };
}

/** A site that is registered and authorized. */
export async function registeredSite(store: PgWebScanStore, hostname = 'example.com') {
  return store.createSite('admin-1', {
    hostname,
    baseUrl: `https://${hostname}`,
    ownerUserId: 'admin-1',
    scope: defaultScope(hostname, `https://${hostname}`),
    authorizedBy: 'admin-1',
  });
}

/** The scanner is switched on, otherwise nothing may be queued. */
export async function unpause(store: PgWebScanStore): Promise<void> {
  await store.updateSettings('admin-1', { paused: false });
}

/** The finding of one occurrence. The same shape is used by every transition. */
export function occurrenceFinding(overrides: {
  occurrenceKey: string;
  issueKey: string;
  evidenceHash: string;
  comparison: Comparison;
  evidence: unknown;
}) {
  return {
    occurrenceKey: overrides.occurrenceKey,
    targetKey: 'target-1',
    issueKey: overrides.issueKey,
    checkId: 'headers',
    checkVersion: 1,
    issueId: 'headers/strict-transport-security',
    subject: 'Strict-Transport-Security',
    severity: 'medium',
    validation: 'Likely',
    confidence: 'high',
    safeLocation: 'https://example.com/',
    evidenceHash: overrides.evidenceHash,
    evidence: overrides.evidence,
    comparison: overrides.comparison,
  };
}

/** Moves the last observation of the ledger of a site into the past. */
export async function backdateLedger(db: TestDbHandle, siteId: string): Promise<void> {
  await db.client.query(
    `UPDATE web_scan_occurrences SET last_observed_at = $1 WHERE site_id = $2`,
    [new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), siteId],
  );
}

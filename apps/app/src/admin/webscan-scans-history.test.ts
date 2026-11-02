import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';

/**
 * The findings of a scan (ADR-0052 sections 6 and 11).
 *
 * A scan keeps its own findings, so the detail of a scan shows what that scan found
 * and not what the ledger of the site holds now. An older scan keeps showing the
 * findings of its own run, and a scan that found nothing shows nothing.
 */

const OCCURRENCE_A = 'a'.repeat(64);
const EVIDENCE_A = 'b'.repeat(64);
const OCCURRENCE_B = 'c'.repeat(64);
const EVIDENCE_B = 'd'.repeat(64);

/** The finding of the first scan: one missing header. */
const findingA = {
  occurrenceKey: OCCURRENCE_A,
  targetKey: 'target-a',
  issueKey: 'headers|headers/strict-transport-security|example.com',
  checkId: 'headers' as const,
  checkVersion: 1,
  issueId: 'headers/strict-transport-security',
  subject: 'Strict-Transport-Security',
  severity: 'medium' as const,
  validation: 'Likely' as const,
  confidence: 'high' as const,
  safeLocation: 'https://example.com/',
  evidenceHash: EVIDENCE_A,
  evidence: { header: 'missing' },
  comparison: 'New' as const,
};

/** The finding of the second scan: another missing header, and a worse one. */
const findingB = {
  ...findingA,
  occurrenceKey: OCCURRENCE_B,
  targetKey: 'target-b',
  issueKey: 'headers|headers/content-security-policy|example.com',
  issueId: 'headers/content-security-policy',
  subject: 'Content-Security-Policy',
  severity: 'high' as const,
  evidenceHash: EVIDENCE_B,
};

describe('the findings of a scan (Task 8B)', () => {
  let h: WebScanAdminHarness;
  let app: FastifyInstance;
  let siteId: string;

  beforeEach(async () => {
    h = await createWebScanAdminApp();
    app = h.app;
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: {
        hostname: 'example.com',
        baseUrl: 'https://example.com',
        scope: {
          crawlPaths: [],
          blockedPaths: [],
          parameterizedPaths: [],
          activePaths: [],
          extraFilePaths: [],
        },
        authorize: true,
      },
    });
    siteId = created.json().id as string;
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
  });

  afterEach(async () => {
    await app.close();
    await h.handle.close();
  });

  /** Queues a manual scan and answers with its id. */
  const enqueue = async (key: string): Promise<string> => {
    const queued = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { idempotencyKey: key, authorize: true },
    });
    return queued.json().scan.id as string;
  };

  const detailOf = async (scanId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${scanId}`,
      headers: { cookie: h.adminCookie },
    });

  it('shows the findings of the scan itself and not the current ledger of the site', async () => {
    // The first scan observes one finding.
    const firstId = await enqueue('history-key-0001');
    await h.store.recordScanOutcome('worker', {
      scanId: firstId,
      siteId,
      status: 'completed',
      requests: 3,
      pages: 1,
      durationMs: 60,
      findings: [{ id: 'finding-a', scanId: firstId, siteId, ...findingA }],
      coverage: [],
      updates: [{ state: 'outstanding', finding: findingA }],
    });

    // The second scan proves that finding fixed and observes another one.
    const secondId = await enqueue('history-key-0002');
    await h.store.recordScanOutcome('worker', {
      scanId: secondId,
      siteId,
      status: 'completed',
      requests: 4,
      pages: 1,
      durationMs: 75,
      findings: [
        { id: 'finding-a-fixed', scanId: secondId, siteId, ...findingA, comparison: 'Fixed' },
        { id: 'finding-b', scanId: secondId, siteId, ...findingB },
      ],
      coverage: [],
      updates: [
        { state: 'fixed', finding: { ...findingA, comparison: 'Fixed' } },
        { state: 'outstanding', finding: findingB },
      ],
    });

    // The detail of the first scan still shows the finding it observed. The ledger of
    // the site says that the finding is fixed now, and the second scan found
    // another one: neither of them belongs to the first scan.
    const detail = await detailOf(firstId);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().occurrences).toHaveLength(1);
    const occurrence = detail.json().occurrences[0];
    expect(occurrence.occurrenceKey).toBe(OCCURRENCE_A);
    expect(occurrence.comparison).toBe('New');
    expect(occurrence.state).toBe('outstanding');
    expect(occurrence.archiveReason).toBeNull();
    expect(occurrence.evidence).toEqual({ header: 'missing' });
    expect(detail.body).not.toContain(OCCURRENCE_B);

    // The detail of the second scan shows both of its findings. The worse one comes
    // first: the findings of a scan are ordered by their severity.
    const secondDetail = await detailOf(secondId);
    const occurrences = secondDetail.json().occurrences as Array<{
      occurrenceKey: string;
      comparison: string;
      state: string;
    }>;
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((row) => row.occurrenceKey)).toEqual([OCCURRENCE_B, OCCURRENCE_A]);
    const fixed = occurrences.find((row) => row.occurrenceKey === OCCURRENCE_A);
    const outstanding = occurrences.find((row) => row.occurrenceKey === OCCURRENCE_B);
    expect(fixed?.comparison).toBe('Fixed');
    expect(fixed?.state).toBe('fixed');
    expect(outstanding?.comparison).toBe('New');
    expect(outstanding?.state).toBe('outstanding');
  });

  it('shows no occurrence for a scan that found nothing, even when the ledger has some', async () => {
    // A completed scan that observed one occurrence.
    const completedId = await enqueue('stopped-key-0001');
    await h.store.recordScanOutcome('worker', {
      scanId: completedId,
      siteId,
      status: 'completed',
      requests: 3,
      pages: 1,
      durationMs: 60,
      findings: [{ id: 'finding-a', scanId: completedId, siteId, ...findingA }],
      coverage: [],
      updates: [{ state: 'outstanding', finding: findingA }],
    });

    // A stopped scan that found nothing.
    const stoppedId = await enqueue('stopped-key-0002');
    await h.store.recordScanOutcome('worker', {
      scanId: stoppedId,
      siteId,
      status: 'stopped',
      stopReason: 'cancelled',
      requests: 1,
      pages: 0,
      durationMs: 10,
      findings: [],
      coverage: [],
      updates: [],
    });

    // The ledger of the site holds the outstanding occurrence of the first scan.
    const ledger = await h.store.listOccurrences(siteId);
    expect(ledger).toHaveLength(1);

    // The stopped scan shows nothing of it: it never observed it.
    const detail = await detailOf(stoppedId);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().occurrences).toEqual([]);
  });
});

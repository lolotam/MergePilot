import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';

/**
 * The administrator resolutions of a site (ADR-0052 section 9).
 *
 * A resolution is recorded against an identity that was really observed, and it
 * carries a bounded reason category and a free-form reason. The reason belongs to
 * this admin API: it never reaches a log line, an error body or an event.
 */

const OCCURRENCE_KEY = 'a'.repeat(64);
const EVIDENCE_HASH = 'b'.repeat(64);
const OTHER_OCCURRENCE_KEY = 'c'.repeat(64);
// The token is assembled at run time so no credential-shaped literal sits in the source.
const SECRET_TOKEN = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('_');
/** A reason an administrator pasted a credential into. */
const SECRET_REASON = `the deploy header was Authorization: Bearer ${SECRET_TOKEN}`;
/** The same reason with the credential redacted. */
const REDACTED_REASON = 'the deploy header was Authorization: Bearer [REDACTED:github]';

describe('the web-scan exception routes (Task 8B)', () => {
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
    await observeOccurrence();
  });

  afterEach(async () => {
    await app.close();
    await h.handle.close();
  });

  /** Records a completed scan that observed one occurrence as outstanding. */
  const observeOccurrence = async () => {
    const queued = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { idempotencyKey: 'exception-key-0001', authorize: true },
    });
    const scanId = queued.json().scan.id as string;
    await h.store.recordScanOutcome('worker', {
      scanId,
      siteId,
      status: 'completed',
      requests: 2,
      pages: 1,
      durationMs: 40,
      findings: [],
      coverage: [],
      updates: [
        {
          state: 'outstanding',
          finding: {
            occurrenceKey: OCCURRENCE_KEY,
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
            evidenceHash: EVIDENCE_HASH,
            evidence: { header: 'missing' },
            comparison: 'New',
          },
        },
      ],
    });
  };

  const createException = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/exceptions`,
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: body,
    });

  const listExceptions = () =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}/exceptions`,
      headers: { cookie: h.adminCookie },
    });

  const revoke = (exceptionId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/admin/web-scan/sites/${siteId}/exceptions/${exceptionId}`,
      headers: { cookie: h.adminCookie },
    });

  /** The audit rows of one resolution, newest first. */
  const revokeAuditRows = async (exceptionId: string) =>
    (await h.store.listAudit({ targetType: 'exception', targetId: exceptionId })).filter(
      (row) => row.action === 'exception.revoke',
    );

  it('records a resolution, lists it and revokes it', async () => {
    const created = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: 'The edge proxy sets the header.',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.kind).toBe('accepted');
    expect(body.reasonCategory).toBe('accepted_risk');
    expect(body.reason).toBe('The edge proxy sets the header.');
    expect(body.expiresAt).toBeNull();
    expect(body.revokedAt).toBeNull();
    expect(body.createdBy).toBe('u-admin');

    const listed = await listExceptions();
    expect(listed.statusCode).toBe(200);
    expect(listed.json().exceptions).toHaveLength(1);
    expect(listed.json().exceptions[0].id).toBe(body.id);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/admin/web-scan/sites/${siteId}/exceptions/${body.id}`,
      headers: { cookie: h.adminCookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toEqual(expect.any(String));
    expect(revoked.json().revokedBy).toBe('u-admin');

    // The resolution no longer holds the finding, so it is outstanding again.
    const occurrences = await h.store.listOccurrences(siteId);
    expect(occurrences[0]?.exceptionId).toBeNull();
    expect(occurrences[0]?.state).toBe('outstanding');
  });

  it('refuses a second revocation of the same resolution', async () => {
    const created = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: 'The edge proxy sets the header.',
    });
    expect(created.statusCode).toBe(201);
    const exceptionId = created.json().id as string;

    const first = await revoke(exceptionId);
    expect(first.statusCode).toBe(200);
    expect(first.json().revokedAt).toEqual(expect.any(String));
    expect(first.json().revokedBy).toBe('u-admin');
    expect(await revokeAuditRows(exceptionId)).toHaveLength(1);

    // The resolution is already revoked, so the second revocation is a conflict.
    const second = await revoke(exceptionId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toEqual({
      code: 'conflict',
      message: 'The request conflicts with the current state',
    });

    // The revocation metadata and the log are the ones of the first revocation.
    const listed = await listExceptions();
    expect(listed.json().exceptions[0].revokedAt).toBe(first.json().revokedAt);
    expect(listed.json().exceptions[0].revokedBy).toBe(first.json().revokedBy);
    expect(await revokeAuditRows(exceptionId)).toHaveLength(1);
  });

  it('accepts a written moment and refuses an impossible one', async () => {
    const accepted = [
      '2030-01-01T00:00:00Z',
      '2030-01-01T03:00:00+03:00',
      '2030-01-01T00:00:00.123Z',
    ];
    for (const expiresAt of accepted) {
      const res = await createException({
        occurrenceKey: OCCURRENCE_KEY,
        evidenceHash: EVIDENCE_HASH,
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The edge proxy sets the header.',
        expiresAt,
      });
      expect(res.statusCode).toBe(201);
      expect(new Date(res.json().expiresAt).getTime()).toBe(new Date(expiresAt).getTime());
    }

    const refused = [
      '2026-13-45T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-01-01T25:00:00Z',
      '2026-01-01T00:00:00',
    ];
    for (const expiresAt of refused) {
      const res = await createException({
        occurrenceKey: OCCURRENCE_KEY,
        evidenceHash: EVIDENCE_HASH,
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The edge proxy sets the header.',
        expiresAt,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toEqual({
        code: 'invalid_request',
        message: 'The timestamp must be written as ISO 8601',
      });
    }
  });

  it('accepts an expiry in the future and refuses one in the past', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const accepted = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'false_positive',
      reasonCategory: 'not_applicable',
      reason: 'The header is set for the whole host.',
      expiresAt: future,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().expiresAt).toBe(future);

    const past = new Date(Date.now() - 86_400_000).toISOString();
    const refused = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'false_positive',
      reasonCategory: 'not_applicable',
      reason: 'The header is set for the whole host.',
      expiresAt: past,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('invalid_request');
    expect((await listExceptions()).json().exceptions).toHaveLength(1);
  });

  it('refuses an unknown reason category and an unknown key', async () => {
    const badCategory = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'because_i_said_so',
      reason: 'The header is set for the whole host.',
    });
    expect(badCategory.statusCode).toBe(422);
    expect(badCategory.json().error.code).toBe('invalid_request');

    const badKey = await createException({
      occurrenceKey: 'not-a-digest',
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: 'The header is set for the whole host.',
    });
    expect(badKey.statusCode).toBe(422);
    expect((await listExceptions()).json().exceptions).toHaveLength(0);
  });

  it('refuses a resolution of an identity that was never observed', async () => {
    const res = await createException({
      occurrenceKey: OTHER_OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: 'The header is set for the whole host.',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'not_found', message: 'Not found' });
  });

  it('answers a resolution of another site with 404 and leaves it alone', async () => {
    const created = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: 'The edge proxy sets the header.',
    });
    const other = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: {
        hostname: 'other.example.com',
        baseUrl: 'https://other.example.com',
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
    const otherSiteId = other.json().id as string;

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/admin/web-scan/sites/${otherSiteId}/exceptions/${created.json().id}`,
      headers: { cookie: h.adminCookie },
    });
    expect(revoked.statusCode).toBe(404);

    // The resolution of the first site is untouched.
    const stillThere = await listExceptions();
    expect(stillThere.json().exceptions[0].revokedAt).toBeNull();
  });

  it('keeps the free-form reason out of every log line and out of an error body', async () => {
    const created = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: SECRET_REASON,
    });
    expect(created.statusCode).toBe(201);
    // The administrator does get the reason back, but the credential in it never
    // reaches the response, the stored row or the audit log.
    expect(created.json().reason).toBe(REDACTED_REASON);
    expect(created.body).not.toContain(SECRET_TOKEN);

    const stored = await h.store.listExceptions(siteId);
    expect(stored[0]?.reason).toBe(REDACTED_REASON);

    // The log was really captured, and it never carries the reason.
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line).not.toContain(SECRET_REASON);
      expect(line).not.toContain(SECRET_TOKEN);
    }

    // A rejected request never echoes the reason either.
    const refused = await createException({
      occurrenceKey: OTHER_OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: SECRET_REASON,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain(SECRET_REASON);
    for (const line of h.logs) {
      expect(line).not.toContain(SECRET_REASON);
    }
  });

  it('redacts a pasted credential out of the reason and audits the redacted one', async () => {
    const created = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: SECRET_REASON,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reason).toBe(REDACTED_REASON);
    // The text around the credential is kept, so the reason still says something.
    expect(created.json().reason).toContain('the deploy header was Authorization: Bearer ');

    // The audit log of the resolution carries the redacted reason, never the token.
    const exceptionId = created.json().id as string;
    const revoked = await revoke(exceptionId);
    expect(revoked.statusCode).toBe(200);
    const rows = await h.store.listAudit({ targetType: 'exception', targetId: exceptionId });
    const revocation = rows.find((row) => row.action === 'exception.revoke');
    expect(revocation).toBeDefined();
    expect(JSON.stringify(revocation?.before)).toContain('[REDACTED:github]');
    expect(JSON.stringify(revocation?.before)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(revocation?.after)).not.toContain(SECRET_TOKEN);
  });

  it('leaves a plain reason unchanged', async () => {
    const created = await createException({
      occurrenceKey: OCCURRENCE_KEY,
      evidenceHash: EVIDENCE_HASH,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: 'The edge proxy sets the header.',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reason).toBe('The edge proxy sets the header.');
    const stored = await h.store.listExceptions(siteId);
    expect(stored[0]?.reason).toBe('The edge proxy sets the header.');
  });
});

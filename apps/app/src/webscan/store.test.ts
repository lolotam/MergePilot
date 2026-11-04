import { describe, expect, it } from 'vitest';
import { defaultScope } from './pg-rows.js';
import { fixture, occurrenceFinding, registeredSite, unpause } from './store.fixtures.js';
import { WebScanConflictError } from './store.js';

describe('the web scan settings', () => {
  it('starts paused with no site, no schedule and no approved installation', async () => {
    const { db, store } = await fixture();
    try {
      const settings = await store.getSettings();
      expect(settings.paused).toBe(true);
      expect(settings.alertsEnabled).toBe(false);
      expect(settings.approvedInstallations).toEqual([]);
      expect(settings.defaultSchedule.enabled).toBe(false);
      expect(await store.listSites()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('writes a settings change and its audit row together', async () => {
    const { db, store } = await fixture();
    try {
      const updated = await store.updateSettings('admin-1', {
        paused: false,
        contact: 'security@example.com',
      });

      expect(updated.paused).toBe(false);
      expect(updated.contact).toBe('security@example.com');
      // The approved-installation list has its own audited write, so a settings
      // change never touches it.
      expect(updated.approvedInstallations).toEqual([]);

      const audit = await store.listAudit({ targetType: 'settings' });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('settings.update');
      expect(audit[0]?.actor).toBe('admin-1');
    } finally {
      await db.close();
    }
  });

  it('rolls the change back when the audit insert fails', async () => {
    const { db, store } = await fixture();
    try {
      // The audit table is renamed outside the transaction, so the audit insert of the
      // transaction fails with a real database error.
      await db.client.exec(`ALTER TABLE web_scan_audit RENAME TO web_scan_audit_broken;`);
      try {
        await expect(store.updateSettings('admin-1', { paused: false })).rejects.toThrow();
      } finally {
        await db.client.exec(`ALTER TABLE web_scan_audit_broken RENAME TO web_scan_audit;`);
      }

      // The mutation never committed.
      expect((await store.getSettings()).paused).toBe(true);
      expect(await store.listAudit()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('refuses a change that was computed from a snapshot the row moved away from', async () => {
    const { db, store } = await fixture();
    try {
      // Two changes are computed from the same snapshot of the row.
      const snapshot = await store.getSettings();
      const first = await store.updateSettings('admin-1', {
        limits: { maxRequests: 600 },
        expectedUpdatedAt: snapshot.updatedAt,
      });
      expect(first.limits.maxRequests).toBe(600);

      // The second one would merge into limits that the first one never saw.
      await expect(
        store.updateSettings('admin-2', {
          limits: { maxPages: 200 },
          expectedUpdatedAt: snapshot.updatedAt,
        }),
      ).rejects.toBeInstanceOf(WebScanConflictError);

      // The settings are the ones of the first change.
      const settings = await store.getSettings();
      expect(settings.limits.maxRequests).toBe(600);
      expect(settings.limits.maxPages).toBe(100);
      expect(await store.listAudit({ targetType: 'settings' })).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('accepts a change that carries no snapshot', async () => {
    const { db, store } = await fixture();
    try {
      const updated = await store.updateSettings('admin-1', { paused: false });
      expect(updated.paused).toBe(false);
    } finally {
      await db.close();
    }
  });
});

describe('the web scan sites', () => {
  it('seals the identity key and never writes it to the audit log', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      const envelope = await store.listIdentityEnvelopes();
      expect(envelope).toHaveLength(1);
      expect(envelope[0]?.siteId).toBe(site.id);

      // The sealed key opens, and it is a key the site can be identified with.
      const identityKey = await store.openSiteIdentityKey(site.id);
      expect(identityKey).toBeTruthy();

      // The audit log holds the change, but never the sealed key.
      const audit = await store.listAudit();
      const text = JSON.stringify(audit);
      expect(text).not.toContain(envelope[0]!.ciphertext);
      expect(text).not.toContain(identityKey!);
      expect(audit.map((entry) => entry.action)).toContain('site.create');
    } finally {
      await db.close();
    }
  });

  it('restores the original row and id of a removed site for the same owner', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      await store.updateSite('admin-1', site.id, {
        schedule: { frequency: 'weekly', weekday: 3, hour: 4, minute: 0, enabled: true },
      });
      await store.removeSite('admin-1', site.id);

      const removed = await store.getSite(site.id);
      expect(removed?.removedAt).not.toBeNull();
      expect(removed?.authorization.auditId).toBeNull();

      const restored = await registeredSite(store);
      expect(restored.id).toBe(site.id);
      expect(restored.removedAt).toBeNull();
      // The fresh registration carries a fresh authorization and a fresh scope.
      expect(restored.authorization.auditId).not.toBeNull();
      expect(restored.authorization.scopeVersion).toBeGreaterThan(1);
      expect(restored.schedule).toBeNull();

      const audit = await store.listAudit({ targetId: site.id });
      expect(audit.map((entry) => entry.action)).toContain('site.restore');
    } finally {
      await db.close();
    }
  });

  it('refuses to hand a removed hostname to another owner', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      await store.removeSite('admin-1', site.id);

      await expect(
        store.createSite('admin-2', {
          hostname: 'example.com',
          baseUrl: 'https://example.com',
          ownerUserId: 'admin-2',
          scope: defaultScope('example.com', 'https://example.com'),
          authorizedBy: 'admin-2',
        }),
      ).rejects.toBeInstanceOf(WebScanConflictError);

      // The site still belongs to the first owner.
      expect((await store.getSite(site.id))?.ownerUserId).toBe('admin-1');
    } finally {
      await db.close();
    }
  });

  it('stops the queued scans and invalidates the authorization on removal', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      expect(scan.status).toBe('queued');

      await store.removeSite('admin-1', site.id);

      const stopped = await store.getScan(scan.id);
      expect(stopped?.status).toBe('stopped');
      expect(stopped?.stopReason).toBe('site_removed');
      expect((await store.getSite(site.id))?.authorization.auditId).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('keeps the identity key and the exceptions of a restored site', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      await unpause(store);
      // A resolution always names an identity that was really observed, so the ledger
      // of the site holds the occurrence the resolution is recorded against.
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-exception',
      });
      await store.recordScanOutcome('worker', {
        scanId: scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 1,
        pages: 1,
        durationMs: 10,
        findings: [],
        coverage: [],
        updates: [
          {
            state: 'outstanding',
            finding: occurrenceFinding({
              occurrenceKey: 'occ-1',
              issueKey: 'headers|headers/strict-transport-security|example.com',
              evidenceHash: 'hash-1',
              comparison: 'New',
              evidence: { header: 'missing' },
            }),
          },
        ],
      });
      const exception = await store.createException('admin-1', {
        siteId: site.id,
        occurrenceKey: 'occ-1',
        evidenceHash: 'hash-1',
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The header is set by the edge proxy.',
      });
      const envelopeBefore = (await store.listIdentityEnvelopes())[0];
      const keyBefore = await store.openSiteIdentityKey(site.id);

      await store.removeSite('admin-1', site.id);
      await registeredSite(store);

      const envelopeAfter = (await store.listIdentityEnvelopes())[0];
      expect(envelopeAfter?.ciphertext).toBe(envelopeBefore?.ciphertext);
      expect(envelopeAfter?.keyVersion).toBe(envelopeBefore?.keyVersion);
      expect(await store.openSiteIdentityKey(site.id)).toBe(keyBefore);
      expect((await store.listExceptions(site.id)).map((row) => row.id)).toEqual([exception.id]);
    } finally {
      await db.close();
    }
  });

  it('stops the queued scans when the scope or the schedule changes', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });

      // A fresh authorization that keeps the scope leaves the queued work alone.
      await store.updateSite('admin-1', site.id, { authorizedBy: 'admin-2' });
      expect((await store.getScan(scan.id))?.status).toBe('queued');

      // A changed scope invalidates the authorization the scan was queued under.
      await store.updateSite('admin-1', site.id, {
        scope: {
          ...defaultScope('example.com', 'https://example.com'),
          crawlPaths: [{ path: '/app', kind: 'prefix' }],
        },
      });
      const stopped = await store.getScan(scan.id);
      expect(stopped?.status).toBe('stopped');
      expect(stopped?.stopReason).toBe('authorization_revoked');
    } finally {
      await db.close();
    }
  });
});

describe('the retained ledger', () => {
  it('keeps the occurrence when a completed scan evaluated it and archives it when nobody did', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });

      await store.recordScanOutcome('worker', {
        scanId: scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 3,
        pages: 1,
        durationMs: 120,
        findings: [],
        coverage: [
          {
            targetKey: 'target-1',
            checkId: 'headers',
            checkVersion: 1,
            evaluatedIssueIds: ['headers/strict-transport-security'],
            outcome: 'checked',
          },
        ],
        updates: [
          {
            state: 'outstanding',
            finding: {
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
              comparison: 'New',
            },
          },
        ],
      });

      const occurrences = await store.listOccurrences(site.id);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.state).toBe('outstanding');
      expect(occurrences[0]?.evidence).toEqual({ header: 'missing' });

      // The occurrence was evaluated by a completed scan, so it never becomes a
      // tombstone, no matter how long the horizon is.
      await store.updateSettings('admin-1', { retentionDays: 1 });
      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(0);
      expect((await store.listOccurrences(site.id))[0]?.state).toBe('outstanding');
    } finally {
      await db.close();
    }
  });

  it('archives an occurrence nobody evaluated and keeps it as a tombstone', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });

      await store.recordScanOutcome('worker', {
        scanId: scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 3,
        pages: 1,
        durationMs: 120,
        findings: [],
        coverage: [],
        updates: [
          {
            state: 'outstanding',
            finding: {
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
              comparison: 'New',
            },
          },
        ],
      });

      // The horizon is one day and the occurrence was observed now, so it is not
      // eligible yet.
      await store.updateSettings('admin-1', { retentionDays: 1 });
      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(0);
    } finally {
      await db.close();
    }
  });
});
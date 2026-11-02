import { describe, expect, it } from 'vitest';
import { resolveAuthorizingActor } from './worker-authorization.js';
import { fixture, registeredSite, unpause } from './store.fixtures.js';
import { harness, scan, site } from './worker.fixtures.js';
import type { WebScanWorkerDeps } from './worker.js';

/**
 * The authorization of a queued scan (ADR-0052 sections 1 and 10).
 *
 * A scan names the authorization it runs under by the id of the audit row that
 * recorded it. A manual scan names its own row, because the administrator confirmed
 * the authorization of that scan and not the one of the site.
 */

describe('the original authorization audit fallback', () => {
  it('accepts only a site.authorize record for the recorded reference', async () => {
    const reauthorized = { ...site, authorization: { ...site.authorization, auditId: 'new-authorization' } };
    const audit = { id: scan.authorizationAuditId ?? 'missing-reference', after: { authorizedBy: 'admin-1' } };
    const unrelated = harness({ audit: [{ ...audit, action: 'site.update' }] });
    expect(await resolveAuthorizingActor(unrelated.deps, reauthorized, scan)).toBeNull();
    const authorization = harness({ audit: [{ ...audit, action: 'site.authorize' }] });
    expect(await resolveAuthorizingActor(authorization.deps, reauthorized, scan)).toBe('admin-1');
  });

  it('finds the row of the scan by its id and not in a page of the log', async () => {
    const reauthorized = {
      ...site,
      authorization: { ...site.authorization, auditId: 'new-authorization' },
    };
    // The row of the scan is not in the page of the site log, but it is found by
    // its id.
    const deps = harness({
      audit: [{ id: scan.authorizationAuditId ?? 'missing', action: 'site.authorize', after: { authorizedBy: 'admin-2' } }],
    });
    expect(await resolveAuthorizingActor(deps.deps, reauthorized, scan)).toBe('admin-2');
  });

  it('resolves the administrator that confirmed a manual scan', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      // Another administrator confirms the authorization of this scan.
      const { scan: queued } = await store.enqueueManualScan('admin-2', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });

      const deps: WebScanWorkerDeps = { ...harness().deps, store };
      expect(await resolveAuthorizingActor(deps, site, queued)).toBe('admin-2');
    } finally {
      await db.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { resolveAuthorizingActor } from './worker-authorization.js';
import { harness, scan, site } from './worker.fixtures.js';

describe('the original authorization audit fallback', () => {
  it('accepts only a site.authorize record for the recorded reference', async () => {
    const reauthorized = { ...site, authorization: { ...site.authorization, auditId: 'new-authorization' } };
    const audit = { id: scan.authorizationAuditId ?? 'missing-reference', after: { authorizedBy: 'admin-1' } };
    const unrelated = harness({ audit: [{ ...audit, action: 'site.update' }] });
    expect(await resolveAuthorizingActor(unrelated.deps, reauthorized, scan)).toBeNull();
    const authorization = harness({ audit: [{ ...audit, action: 'site.authorize' }] });
    expect(await resolveAuthorizingActor(authorization.deps, reauthorized, scan)).toBe('admin-1');
  });
});

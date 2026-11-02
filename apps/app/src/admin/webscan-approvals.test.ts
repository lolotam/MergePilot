import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { webScanSettings } from '../db/schema.js';
import type { WebScanGitHubVerifier } from '../webscan/github-target.js';
import type { WebScanGitHubTargetReason } from '../webscan/github-target-reasons.js';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';
import {
  TARGET_ACCOUNT_ID,
  TARGET_INSTALLATION_ID,
  aTargetVerifier,
} from './webscan-target.fixtures.js';

/**
 * The tests of the approval of an installation of the GitHub App
 * (ADR-0052 section 8).
 *
 * The GitHub boundary is a fake, so no test ever reaches GitHub. The database is
 * the real one, so the approval and its audit row are really written.
 *
 * The database is shared by the tests of this file: the approval list is
 * emptied between them, and the audit log is append-only, so every test counts
 * the rows it wrote itself.
 */

const INSTALLATION_ID = TARGET_INSTALLATION_ID;
const ACCOUNT_ID = TARGET_ACCOUNT_ID;

/** A verifier that refuses the approval, so the route never writes anything. */
function aRefusingVerifier(reason: WebScanGitHubTargetReason): WebScanGitHubVerifier {
  return aTargetVerifier({
    approveInstallation: async () => ({ ok: false, reason }),
  });
}

describe('the approval routes of the scanner', () => {
  let harness: WebScanAdminHarness;
  /** The number of audit rows the log held before the test. */
  let auditTotalBefore = 0;

  const approve = async (cookie: string, installationId = INSTALLATION_ID) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/settings/approved-installations',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { installationId },
    });

  const revoke = async (cookie: string, installationId: string | number = INSTALLATION_ID) =>
    harness.app.inject({
      method: 'DELETE',
      url: `/api/admin/web-scan/settings/approved-installations/${installationId}`,
      headers: { cookie },
    });

  const getSettings = async (cookie: string) =>
    harness.app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/settings',
      headers: { cookie },
    });

  const getAudit = async (cookie: string) =>
    harness.app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/audit?limit=100',
      headers: { cookie },
    });

  /**
   * The audit rows of the settings that the test itself wrote.
   *
   * The log is append-only and its page comes back newest first, so the rows of
   * the test are the newest ones: they are the first rows of the page, and
   * their number is how much the log grew since the test started.
   */
  const auditRowsOfThisTest = async () => {
    const body = (await getAudit(harness.adminCookie)).json() as {
      audit: Array<{ action: string }>;
      total: number;
    };
    return body.audit.slice(0, Math.max(0, body.total - auditTotalBefore));
  };

  beforeAll(async () => {
    harness = await createWebScanAdminApp({ github: aTargetVerifier() });
  });

  beforeEach(async () => {
    await harness.handle.db
      .update(webScanSettings)
      .set({ approvedInstallations: [], updatedBy: null });
    auditTotalBefore = (await getAudit(harness.adminCookie)).json().total;
  });

  it('answers the regular 404 to everyone who is not a platform administrator', async () => {
    for (const cookie of [harness.unverifiedCookie, harness.workspaceAdminCookie, harness.regularCookie]) {
      const approved = await approve(cookie);
      expect(approved.statusCode).toBe(404);
      const revoked = await revoke(cookie);
      expect(revoked.statusCode).toBe(404);
    }
    expect((await getSettings(harness.adminCookie)).json().approvedInstallations).toEqual([]);
    expect(await auditRowsOfThisTest()).toEqual([]);
  });

  it('writes the approved installation and one audit row', async () => {
    const approved = await approve(harness.adminCookie);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({
      approvedInstallation: {
        adminUserId: 'u-admin',
        installationId: INSTALLATION_ID,
        githubAccountId: ACCOUNT_ID,
      },
    });

    const settings = await getSettings(harness.adminCookie);
    expect(settings.json().approvedInstallations).toEqual([
      { adminUserId: 'u-admin', installationId: INSTALLATION_ID, githubAccountId: ACCOUNT_ID },
    ]);

    const rows = await auditRowsOfThisTest();
    expect(rows.filter((row) => row.action === 'settings.approve_installation')).toHaveLength(1);
    expect(rows[0]?.actor).toBe('u-admin');
  });

  it('writes nothing and no audit row when the verification fails', async () => {
    const refusing = await createWebScanAdminApp({
      github: aRefusingVerifier('installation_not_accessible'),
    });
    try {
      const approved = await refusing.app.inject({
        method: 'POST',
        url: '/api/admin/web-scan/settings/approved-installations',
        headers: { cookie: refusing.adminCookie, 'content-type': 'application/json' },
        payload: { installationId: INSTALLATION_ID },
      });
      expect(approved.statusCode).toBe(422);
      expect(approved.json().error).toEqual({
        code: 'target_refused',
        reason: 'installation_not_accessible',
        message: 'The installation is not accessible to the administrator',
      });

      const settings = await refusing.app.inject({
        method: 'GET',
        url: '/api/admin/web-scan/settings',
        headers: { cookie: refusing.adminCookie },
      });
      expect(settings.json().approvedInstallations).toEqual([]);
      const audit = await refusing.app.inject({
        method: 'GET',
        url: '/api/admin/web-scan/audit',
        headers: { cookie: refusing.adminCookie },
      });
      expect(audit.json().audit.length).toBe(0);
    } finally {
      await refusing.app.close();
      await refusing.handle.close();
    }
  });

  it('answers 422 when GitHub cannot be reached at all', async () => {
    const withoutGitHub = await createWebScanAdminApp();
    try {
      const approved = await withoutGitHub.app.inject({
        method: 'POST',
        url: '/api/admin/web-scan/settings/approved-installations',
        headers: { cookie: withoutGitHub.adminCookie, 'content-type': 'application/json' },
        payload: { installationId: INSTALLATION_ID },
      });
      expect(approved.statusCode).toBe(422);
      expect(approved.json().error.reason).toBe('github_unavailable');
      const settings = await withoutGitHub.app.inject({
        method: 'GET',
        url: '/api/admin/web-scan/settings',
        headers: { cookie: withoutGitHub.adminCookie },
      });
      expect(settings.json().approvedInstallations).toEqual([]);
    } finally {
      await withoutGitHub.app.close();
      await withoutGitHub.handle.close();
    }
  });

  it('approves the same installation once', async () => {
    await approve(harness.adminCookie);
    const again = await approve(harness.adminCookie);
    expect(again.statusCode).toBe(200);

    const settings = await getSettings(harness.adminCookie);
    expect(settings.json().approvedInstallations).toHaveLength(1);
  });

  it('removes the approval of the administrator and audits it', async () => {
    await approve(harness.adminCookie);
    const revoked = await revoke(harness.adminCookie);
    expect(revoked.statusCode).toBe(204);

    const settings = await getSettings(harness.adminCookie);
    expect(settings.json().approvedInstallations).toEqual([]);

    const rows = await auditRowsOfThisTest();
    expect(rows.filter((row) => row.action === 'settings.revoke_installation')).toHaveLength(1);
  });

  it('answers 404 when the approval that is removed is not there', async () => {
    const revoked = await revoke(harness.adminCookie);
    expect(revoked.statusCode).toBe(404);
    expect(await auditRowsOfThisTest()).toEqual([]);
  });

  it('refuses a body that carries anything else', async () => {
    const bad = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/settings/approved-installations',
      headers: { cookie: harness.adminCookie, 'content-type': 'application/json' },
      payload: { installationId: INSTALLATION_ID, adminUserId: 'u-regular' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('invalid_request');

    const notDigits = await revoke(harness.adminCookie, 'abc');
    expect(notDigits.statusCode).toBe(422);
    expect(notDigits.json().error.code).toBe('invalid_request');
  });

  it('never lets a credential reach a response, a log or the audit', async () => {
    const hostile = ['gh', 'p', '_', 'hostile', 'token', 'value'].join('');
    const approved = await approve(harness.adminCookie);
    expect(approved.body).not.toContain(hostile);
    expect(approved.body.toLowerCase()).not.toContain('token');

    const settings = await getSettings(harness.adminCookie);
    expect(settings.body).not.toContain(hostile);
    expect(settings.body.toLowerCase()).not.toContain('token');

    const audit = await getAudit(harness.adminCookie);
    expect(audit.body).not.toContain(hostile);
    expect(audit.body.toLowerCase()).not.toContain('accesstoken');
    expect(harness.logs.join('\n')).not.toContain(hostile);
  });
});

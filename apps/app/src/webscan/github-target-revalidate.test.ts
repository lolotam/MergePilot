import { describe, expect, it } from 'vitest';
import { GitHubTargetApiError } from './github-target.js';
import {
  createGitHubTargetVerifier,
  isLostWebScanTargetReason,
  revalidateBinding,
} from './github-target-verify.js';
import {
  ACCOUNT_ID,
  ADMIN,
  APPROVED,
  HOSTILE_TOKEN,
  INSTALLATION_ID,
  aRepository,
  deps,
  happyApi,
} from './github-target.fixtures.js';
import type { WebScanApprovedInstallation, WebScanRepositoryBinding } from './types.js';

/**
 * The tests of the revalidation of a stored binding (ADR-0052 section 8).
 *
 * The revalidation runs before every write of an alert, so it has to tell a
 * target that is definitely gone from one that cannot be verified.
 */

const BINDING: WebScanRepositoryBinding = {
  owner: 'acme',
  name: 'demo',
  repositoryId: 7,
  installationId: INSTALLATION_ID,
  githubAccountId: ACCOUNT_ID,
};

/** The revalidation of a binding that still holds. */
function revalidate(
  api: ReturnType<typeof happyApi>,
  approvedInstallations: readonly WebScanApprovedInstallation[] = [APPROVED],
  isAdminStillPlatformAdmin = true,
) {
  return revalidateBinding(
    {
      adminUserId: ADMIN,
      binding: BINDING,
      approvedInstallations,
      isAdminStillPlatformAdmin,
    },
    deps(api),
  );
}

describe('the revalidation of a stored binding', () => {
  it('accepts a binding that still holds', async () => {
    const api = happyApi();
    expect(await revalidate(api)).toEqual({ ok: true });
  });

  it('tells a lost target from one that cannot be verified', async () => {
    const lost = happyApi();
    lost.failures = { getInstallation: 'not_found' };
    expect(await revalidate(lost)).toEqual({ ok: false, reason: 'installation_lost' });
    expect(isLostWebScanTargetReason('installation_lost')).toBe(true);

    for (const status of ['forbidden', 'server_error', 'timeout', 'network'] as const) {
      const api = happyApi();
      api.failures = { getInstallation: status };
      expect(await revalidate(api)).toEqual({ ok: false, reason: 'unverifiable' });
      expect(isLostWebScanTargetReason('unverifiable')).toBe(false);
    }
  });

  it('tells a lost access from a lost target', async () => {
    // The administrator lost the access to the installation: it is not in their
    // own list anymore, while the App still has its own record of it.
    const api = happyApi();
    api.installations = [];
    expect(await revalidate(api)).toEqual({
      ok: false,
      reason: 'installation_not_accessible',
    });
    expect(isLostWebScanTargetReason('installation_not_accessible')).toBe(false);
    expect(api.installation).toBeDefined();
    expect(api.calls).toEqual(['listUserInstallations']);
  });

  it('tells a listing of the repositories that is gone from a lost target', async () => {
    // The App has its own record of the installation, so a 404 of the listing
    // is a loss of the access of the administrator and not a deletion.
    const api = happyApi();
    api.failures = { listInstallationRepositories: 'not_found' };
    expect(await revalidate(api)).toEqual({
      ok: false,
      reason: 'installation_not_accessible',
    });
    expect(isLostWebScanTargetReason('installation_not_accessible')).toBe(false);
  });

  it('refuses a repository that the installation cannot see anymore', async () => {
    const api = happyApi();
    api.failures = { getRepository: 'not_found' };
    expect(await revalidate(api)).toEqual({ ok: false, reason: 'repository_not_found' });
    expect(isLostWebScanTargetReason('repository_not_found')).toBe(true);
  });

  it('refuses an administrator who is no longer a platform administrator', async () => {
    const api = happyApi();
    expect(await revalidate(api, [APPROVED], false)).toEqual({
      ok: false,
      reason: 'admin_not_authorized',
    });
    expect(api.calls).toEqual([]);
  });

  it('refuses a binding whose approval is gone', async () => {
    const api = happyApi();
    expect(await revalidate(api, [])).toEqual({ ok: false, reason: 'approval_missing' });
  });

  it('refuses an approval that belongs to another administrator', async () => {
    const api = happyApi();
    const other: WebScanApprovedInstallation = {
      adminUserId: 'u-other',
      installationId: INSTALLATION_ID,
      githubAccountId: ACCOUNT_ID,
    };
    expect(await revalidate(api, [other])).toEqual({ ok: false, reason: 'approval_missing' });
  });

  it('refuses a repository that became public', async () => {
    const api = happyApi();
    api.repository = aRepository({ private: false, visibility: 'public' });
    expect(await revalidate(api)).toEqual({ ok: false, reason: 'not_private' });
  });

  it('refuses a repository that was transferred to another account', async () => {
    const api = happyApi();
    api.repository = aRepository({ ownerAccountId: 999 });
    expect(await revalidate(api)).toEqual({ ok: false, reason: 'account_mismatch' });
  });

  it('refuses a repository the administrator cannot reach anymore', async () => {
    const api = happyApi();
    api.visible = [];
    expect(await revalidate(api)).toEqual({ ok: false, reason: 'no_user_access' });
    expect(isLostWebScanTargetReason('no_user_access')).toBe(false);
  });
});

describe('the verifier of the routes', () => {
  it('never lets a token reach a result or an error', async () => {
    const api = happyApi();
    api.failures = { getInstallation: 'forbidden' };
    const verifier = createGitHubTargetVerifier(deps(api));
    const result = await verifier.approveInstallation({
      adminUserId: ADMIN,
      installationId: INSTALLATION_ID,
    });
    expect(JSON.stringify(result)).not.toContain(HOSTILE_TOKEN);

    const failing = new GitHubTargetApiError('network');
    expect(String(failing)).not.toContain(HOSTILE_TOKEN);
  });

  it('picks the approved installation of the administrator that owns the repository', async () => {
    const api = happyApi();
    const verifier = createGitHubTargetVerifier(deps(api));
    const other: WebScanApprovedInstallation = {
      adminUserId: ADMIN,
      installationId: 202,
      githubAccountId: 402,
    };
    const selected = await verifier.selectInstallation({
      adminUserId: ADMIN,
      owner: 'acme',
      approvedInstallations: [other, APPROVED],
    });
    expect(selected).toEqual({ ok: true, approved: APPROVED });

    const unknown = await verifier.selectInstallation({
      adminUserId: ADMIN,
      owner: 'other-account',
      approvedInstallations: [other, APPROVED],
    });
    expect(unknown).toEqual({ ok: false, reason: 'repository_not_approved' });

    const none = await verifier.selectInstallation({
      adminUserId: ADMIN,
      owner: 'acme',
      approvedInstallations: [],
    });
    expect(none).toEqual({ ok: false, reason: 'repository_not_approved' });
  });

  it('picks the only approved installation of the administrator', async () => {
    const api = happyApi();
    const verifier = createGitHubTargetVerifier(deps(api));
    const selected = await verifier.selectInstallation({
      adminUserId: ADMIN,
      owner: 'another-account',
      approvedInstallations: [APPROVED],
    });
    expect(selected).toEqual({ ok: true, approved: APPROVED });
  });
});

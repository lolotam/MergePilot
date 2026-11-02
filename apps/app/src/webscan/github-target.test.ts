import { describe, expect, it } from 'vitest';
import { verifyInstallationApproval, verifyRepositoryTarget } from './github-target-verify.js';
import {
  ACCOUNT_ID,
  ADMIN,
  APPROVED,
  HOSTILE_TOKEN,
  INSTALLATION_ID,
  aRepository,
  anInstallation,
  anOwnInstallation,
  deps,
  happyApi,
} from './github-target.fixtures.js';

/**
 * The tests of the proof of a private alert target (ADR-0052 section 8).
 *
 * The GitHub boundary is a fake, so no test ever touches the network.
 */

describe('the approval of an installation of the GitHub App', () => {
  it('proves the installation and takes the account id from GitHub', async () => {
    const api = happyApi();
    const result = await verifyInstallationApproval(
      { adminUserId: ADMIN, installationId: INSTALLATION_ID },
      deps(api),
    );
    expect(result).toEqual({ ok: true, githubAccountId: ACCOUNT_ID });
    expect(api.calls).toEqual(['listUserInstallations', 'getInstallation']);
  });

  it('refuses an administrator without a linked GitHub account', async () => {
    const api = happyApi();
    const result = await verifyInstallationApproval(
      { adminUserId: 'u-other', installationId: INSTALLATION_ID },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'no_github_account' });
    expect(api.calls).toEqual([]);
  });

  it('refuses an installation that is not in the own list of the administrator', async () => {
    const api = happyApi();
    api.installations = [anOwnInstallation({ id: 999 })];
    const result = await verifyInstallationApproval(
      { adminUserId: ADMIN, installationId: INSTALLATION_ID },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'installation_not_accessible' });
    expect(api.calls).toEqual(['listUserInstallations']);
  });

  it('refuses a suspended installation', async () => {
    const api = happyApi();
    api.installation = { ...anInstallation(), suspended: true };
    const result = await verifyInstallationApproval(
      { adminUserId: ADMIN, installationId: INSTALLATION_ID },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'installation_suspended' });
  });

  it('refuses an installation without the issues permission', async () => {
    const api = happyApi();
    api.installation = { ...anInstallation(), issuesWrite: false };
    const result = await verifyInstallationApproval(
      { adminUserId: ADMIN, installationId: INSTALLATION_ID },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'missing_issues_permission' });
  });

  it('refuses an installation the App has no record of', async () => {
    const api = happyApi();
    api.installation = undefined;
    const result = await verifyInstallationApproval(
      { adminUserId: ADMIN, installationId: INSTALLATION_ID },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'installation_not_accessible' });
  });

  it('refuses a failure that proves nothing at all', async () => {
    for (const status of ['forbidden', 'server_error', 'timeout', 'network'] as const) {
      const api = happyApi();
      api.failures = { getInstallation: status };
      const result = await verifyInstallationApproval(
        { adminUserId: ADMIN, installationId: INSTALLATION_ID },
        deps(api),
      );
      expect(result).toEqual({ ok: false, reason: 'unverifiable' });
    }
  });

  it('refuses an account that the two views of GitHub do not agree on', async () => {
    const api = happyApi();
    api.installations = [anOwnInstallation({ accountId: 999 })];
    const result = await verifyInstallationApproval(
      { adminUserId: ADMIN, installationId: INSTALLATION_ID },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'account_mismatch' });
  });
});

describe('the repository of a site', () => {
  it('binds the repository that GitHub reports', async () => {
    const api = happyApi();
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(result).toEqual({
      ok: true,
      binding: {
        owner: 'acme',
        name: 'demo',
        repositoryId: 7,
        installationId: INSTALLATION_ID,
        githubAccountId: ACCOUNT_ID,
      },
    });
  });

  it('refuses a public repository and an internal one', async () => {
    for (const repository of [
      aRepository({ private: false, visibility: 'public' }),
      aRepository({ private: false, visibility: 'internal' }),
    ]) {
      const api = happyApi();
      api.repository = repository;
      const result = await verifyRepositoryTarget(
        { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
        deps(api),
      );
      expect(result).toEqual({ ok: false, reason: 'not_private' });
    }
  });

  it('refuses a repository that was transferred to another account', async () => {
    const api = happyApi();
    api.repository = aRepository({ ownerAccountId: 999 });
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'account_mismatch' });
  });

  it('refuses a repository the administrator cannot see through the installation', async () => {
    const api = happyApi();
    api.visible = [];
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'no_user_access' });
  });

  it('refuses a listing of the repositories that the administrator cannot reach', async () => {
    // The App has its own record of the installation, so a 404 of the listing
    // is a loss of the access of the administrator and not a deletion.
    const api = happyApi();
    api.failures = { listInstallationRepositories: 'not_found' };
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'installation_not_accessible' });
  });

  it('refuses a name that names another repository than the one the installation sees', async () => {
    const api = happyApi();
    api.repository = aRepository({ id: 8 });
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'repository_not_found' });
  });

  it('refuses an installation that lost the issues permission', async () => {
    const api = happyApi();
    api.installation = { ...anInstallation(), issuesWrite: false };
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'missing_issues_permission' });
  });

  it('refuses an installation that is gone', async () => {
    const api = happyApi();
    api.installation = undefined;
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(result).toEqual({ ok: false, reason: 'installation_lost' });
  });

  it('never lets a token reach a result', async () => {
    const api = happyApi();
    api.failures = { getInstallation: 'forbidden' };
    const result = await verifyRepositoryTarget(
      { adminUserId: ADMIN, owner: 'acme', name: 'demo', approved: APPROVED },
      deps(api),
    );
    expect(JSON.stringify(result)).not.toContain(HOSTILE_TOKEN);
  });
});

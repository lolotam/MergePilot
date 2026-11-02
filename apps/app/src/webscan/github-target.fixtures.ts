import type { UserInstallation } from '../auth/github-installations.js';
import {
  GitHubTargetApiError,
  type GitHubTargetApi,
  type GitHubTargetApiStatus,
  type GitHubTargetInstallation,
  type GitHubTargetRepository,
  type GitHubTargetDeps,
} from './github-target.js';
import type { WebScanApprovedInstallation } from './types.js';

/**
 * The shared fixtures of the tests of the private alert target (ADR-0052 section 8).
 *
 * The GitHub boundary is a fake, so no test ever touches the network. The
 * hostile token is built at run time, so no credential-looking literal ever
 * reaches the source.
 */

/** A token-shaped value that is built at run time and must never leak. */
export const HOSTILE_TOKEN = ['gh', 'p', '_', 'hostile', 'token', 'value'].join('');

export const ADMIN = 'u-admin';
export const INSTALLATION_ID = 101;
export const ACCOUNT_ID = 401;

/** The fake of the GitHub boundary. Every call can be made to fail. */
export class FakeGitHubApi implements GitHubTargetApi {
  installations: UserInstallation[] = [];
  installation?: GitHubTargetInstallation | undefined;
  visible: GitHubTargetRepository[] = [];
  repository?: GitHubTargetRepository | undefined;
  failures: Partial<Record<keyof GitHubTargetApi, GitHubTargetApiStatus>> = {};
  /** The calls that were made, in order. */
  calls: string[] = [];

  private fail(call: keyof GitHubTargetApi): void {
    const status = this.failures[call];
    if (status !== undefined) throw new GitHubTargetApiError(status);
  }

  async listUserInstallations(userToken: string): Promise<UserInstallation[]> {
    this.calls.push('listUserInstallations');
    if (userToken !== HOSTILE_TOKEN) throw new GitHubTargetApiError('forbidden');
    this.fail('listUserInstallations');
    return this.installations;
  }

  async listInstallationRepositories(
    userToken: string,
    installationId: number,
  ): Promise<GitHubTargetRepository[]> {
    this.calls.push('listInstallationRepositories');
    if (userToken !== HOSTILE_TOKEN) throw new GitHubTargetApiError('forbidden');
    this.fail('listInstallationRepositories');
    if (installationId !== INSTALLATION_ID) throw new GitHubTargetApiError('not_found');
    return this.visible;
  }

  async getInstallation(installationId: number): Promise<GitHubTargetInstallation> {
    this.calls.push('getInstallation');
    this.fail('getInstallation');
    if (this.installation === undefined || this.installation.id !== installationId) {
      throw new GitHubTargetApiError('not_found');
    }
    return this.installation;
  }

  async getRepository(
    _installationId: number,
    _owner: string,
    _name: string,
  ): Promise<GitHubTargetRepository> {
    this.calls.push('getRepository');
    this.fail('getRepository');
    if (this.repository === undefined) throw new GitHubTargetApiError('not_found');
    return this.repository;
  }
}

/** The installation of the account, as the App reports it. */
export function anInstallation(): GitHubTargetInstallation {
  return {
    id: INSTALLATION_ID,
    accountId: ACCOUNT_ID,
    accountLogin: 'acme',
    suspended: false,
    issuesWrite: true,
  };
}

/** The private repository of the account. */
export function aRepository(
  overrides: Partial<GitHubTargetRepository> = {},
): GitHubTargetRepository {
  return {
    id: 7,
    owner: 'acme',
    name: 'demo',
    private: true,
    ownerAccountId: ACCOUNT_ID,
    visibility: 'private',
    ...overrides,
  };
}

/** The installation of the account, as the administrator's own list reports it. */
export function anOwnInstallation(overrides: Partial<UserInstallation> = {}): UserInstallation {
  return {
    id: INSTALLATION_ID,
    accountLogin: 'acme',
    accountId: ACCOUNT_ID,
    accountType: 'Organization',
    repositorySelection: 'all',
    suspended: false,
    ...overrides,
  };
}

/** The approval of the administrator. */
export const APPROVED: WebScanApprovedInstallation = {
  adminUserId: ADMIN,
  installationId: INSTALLATION_ID,
  githubAccountId: ACCOUNT_ID,
};

/** The dependencies of a test: a fake api and a token reader. */
export function deps(api: GitHubTargetApi): GitHubTargetDeps {
  return {
    api,
    readUserToken: async (userId: string) => (userId === ADMIN ? HOSTILE_TOKEN : null),
  };
}

/** An api that answers the happy path of every call. */
export function happyApi(): FakeGitHubApi {
  const api = new FakeGitHubApi();
  api.installations = [anOwnInstallation()];
  api.installation = anInstallation();
  api.visible = [aRepository()];
  api.repository = aRepository();
  return api;
}

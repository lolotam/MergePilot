import type { UserInstallation } from './user-installations.js';

/** The class of a failed GitHub call. It carries no body and no message of GitHub. */
export type GitHubTargetApiStatus =
  | 'not_found'
  | 'forbidden'
  | 'server_error'
  | 'timeout'
  | 'network';

/** A failed GitHub call. It carries the class of the failure and nothing else. */
export class GitHubTargetApiError extends Error {
  readonly status: GitHubTargetApiStatus;

  constructor(status: GitHubTargetApiStatus) {
    super(`The GitHub request failed: ${status}`);
    this.name = 'GitHubTargetApiError';
    this.status = status;
  }
}

/** One installation of the GitHub App, as GitHub reports it. */
export interface GitHubTargetInstallation {
  id: number;
  /** The numeric id of the account the installation belongs to. */
  accountId: number;
  /** The login of that account. GitHub logins are case-insensitive. */
  accountLogin: string;
  /** Whether the installation is suspended. */
  suspended: boolean;
  /** Whether the App may write issues in this installation. */
  issuesWrite: boolean;
}

/** One repository, as GitHub reports it. */
export interface GitHubTargetRepository {
  id: number;
  owner: string;
  name: string;
  /** True only for a repository nobody but the account may see. */
  private: boolean;
  /** The numeric id of the account that owns the repository. */
  ownerAccountId: number;
  /** The visibility GitHub reports. */
  visibility: 'private' | 'internal' | 'public';
}

/**
 * The GitHub calls the verification needs. Each one returns plain data.
 *
 * Every call throws a `GitHubTargetApiError` when it cannot answer, and it
 * never throws anything else: a token never reaches an error, a log or a
 * response.
 */
export interface GitHubTargetApi {
  /** The installations the signed-in user can access (user token). */
  listUserInstallations(userToken: string): Promise<UserInstallation[]>;
  /** The repositories of one installation the signed-in user can see (user token). */
  listInstallationRepositories(
    userToken: string,
    installationId: number,
  ): Promise<GitHubTargetRepository[]>;
  /** The App's own record of one installation (app JWT). */
  getInstallation(installationId: number): Promise<GitHubTargetInstallation>;
  /** One repository, as the installation sees it (installation token). */
  getRepository(
    installationId: number,
    owner: string,
    name: string,
  ): Promise<GitHubTargetRepository>;
}


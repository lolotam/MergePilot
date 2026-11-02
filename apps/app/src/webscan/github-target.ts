import type { UserInstallation } from '../auth/github-installations.js';
import type { WebScanApprovedInstallation, WebScanRepositoryBinding } from './types.js';
import type { WebScanGitHubTargetReason } from './github-target-reasons.js';

/**
 * The GitHub boundary of the alert target (ADR-0052 section 8).
 *
 * An alert may only reach a private repository that the signed-in platform
 * administrator really reaches through an installation of OUR GitHub App. Every
 * fact of that is proved by GitHub: the administrator's own installation list,
 * the App's own record of the installation and the repository the installation
 * sees. A repository name, a workspace membership or a request body are never
 * proof of anything.
 *
 * The GitHub calls live behind the `GitHubTargetApi` interface, so the
 * verification is pure: it takes the api and a token reader and never touches
 * the network itself. The production implementation of the interface lives in
 * `github-target-api.ts` and the verification itself in `github-target-verify.ts`.
 */

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

/**
 * Reads the GitHub token of a user.
 *
 * The token is a credential: it is used for the call and never returned to a
 * caller that logs it, puts it in an error or shows it to the dashboard.
 */
export type GitHubTokenReader = (userId: string) => Promise<string | null>;

/** The dependencies of the verification. */
export interface GitHubTargetDeps {
  api: GitHubTargetApi;
  readUserToken: GitHubTokenReader;
}

/** The outcome of an installation approval. */
export type InstallationApprovalResult =
  | { ok: true; githubAccountId: number }
  | { ok: false; reason: WebScanGitHubTargetReason };

/** The outcome of a repository target verification. */
export type RepositoryTargetResult =
  | { ok: true; binding: WebScanRepositoryBinding }
  | { ok: false; reason: WebScanGitHubTargetReason };

/** The outcome of the selection of the approved installation of a repository. */
export type InstallationSelectionResult =
  | { ok: true; approved: WebScanApprovedInstallation }
  | { ok: false; reason: WebScanGitHubTargetReason };

/** The outcome of a revalidation of a stored binding. */
export type BindingRevalidationResult =
  | { ok: true }
  | { ok: false; reason: WebScanGitHubTargetReason };

/**
 * The verifier the routes and the worker use.
 *
 * It is bound to the api and the token reader, so a caller never sees a token
 * and never touches the network itself.
 */
export interface WebScanGitHubVerifier {
  /** Proves that the administrator may approve one installation. */
  approveInstallation(input: {
    adminUserId: string;
    installationId: number;
  }): Promise<InstallationApprovalResult>;
  /** Picks the approved installation of the administrator that owns the repository. */
  selectInstallation(input: {
    adminUserId: string;
    owner: string;
    approvedInstallations: readonly WebScanApprovedInstallation[];
  }): Promise<InstallationSelectionResult>;
  /** Proves that the repository is a private target of the approved installation. */
  verifyRepository(input: {
    adminUserId: string;
    owner: string;
    name: string;
    approved: WebScanApprovedInstallation;
  }): Promise<RepositoryTargetResult>;
  /** Re-checks a stored binding before a delivery. */
  revalidateBinding(input: {
    adminUserId: string;
    binding: WebScanRepositoryBinding;
    approvedInstallations: readonly WebScanApprovedInstallation[];
    isAdminStillPlatformAdmin: boolean;
  }): Promise<BindingRevalidationResult>;
}

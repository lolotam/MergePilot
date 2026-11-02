import type { UserInstallation } from '../auth/github-installations.js';
import {
  GitHubTargetApiError,
  type BindingRevalidationResult,
  type GitHubTargetDeps,
  type GitHubTargetInstallation,
  type GitHubTargetRepository,
  type InstallationApprovalResult,
  type InstallationSelectionResult,
  type RepositoryTargetResult,
  type WebScanGitHubVerifier,
} from './github-target.js';
import type { WebScanGitHubTargetReason } from './github-target-reasons.js';
import type { WebScanApprovedInstallation, WebScanRepositoryBinding } from './types.js';

/**
 * The proof of a private alert target (ADR-0052 section 8).
 *
 * Every function here is pure: it takes the GitHub boundary and a token reader
 * and answers with plain data or with a bounded reason code. Nothing is logged,
 * nothing is written and no credential is ever returned.
 */

/**
 * True when the failure means the target is definitely gone.
 *
 * Only a definite 404 of the App's own record of the installation is such a
 * failure: the App itself says that the installation is no longer there. A
 * repository the installation cannot see is not a deletion: the repository may
 * still be there for the account, the selection of the repositories may have
 * changed, and the access can come back.
 */
export function isLostWebScanTargetReason(reason: WebScanGitHubTargetReason): boolean {
  return reason === 'installation_lost';
}

/**
 * The reason a failed GitHub call maps to.
 *
 * A `404` proves the target is gone; every other failure (403, 5xx, a timeout,
 * a network error and anything unexpected) proves nothing at all, so the
 * answer is the same: the target is not approved.
 */
function failureOf(error: unknown): 'not_found' | 'unverifiable' {
  if (error instanceof GitHubTargetApiError && error.status === 'not_found') {
    return 'not_found';
  }
  return 'unverifiable';
}

/** Reads the token of the administrator. A missing token is no proof at all. */
async function readAdminToken(
  deps: GitHubTargetDeps,
  adminUserId: string,
): Promise<string | null> {
  const token = await deps.readUserToken(adminUserId);
  return token === null || token === '' ? null : token;
}

/** The repository of a list, matched by its owner and its name. */
function findRepository(
  repositories: readonly GitHubTargetRepository[],
  owner: string,
  name: string,
): GitHubTargetRepository | undefined {
  return repositories.find(
    (repo) =>
      repo.owner.toLowerCase() === owner.toLowerCase() &&
      repo.name.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * Proves that an administrator may approve one installation of the App.
 *
 * The proof is: the administrator has a GitHub account of their own, the
 * installation is in their own list of installations, it is not suspended, the
 * App has its own record of that installation, that record grants the App
 * `issues: write` and the account id of the installation comes from GitHub.
 *
 * Anything that cannot be proved is a refusal: the approval is never saved on
 * a doubt.
 */
export async function verifyInstallationApproval(
  input: { adminUserId: string; installationId: number },
  deps: GitHubTargetDeps,
): Promise<InstallationApprovalResult> {
  const token = await readAdminToken(deps, input.adminUserId);
  if (token === null) return { ok: false, reason: 'no_github_account' };

  let installations: UserInstallation[];
  try {
    installations = await deps.api.listUserInstallations(token);
  } catch {
    return { ok: false, reason: 'unverifiable' };
  }

  const own = installations.find((row) => row.id === input.installationId);
  if (own === undefined) return { ok: false, reason: 'installation_not_accessible' };
  if (own.suspended) return { ok: false, reason: 'installation_suspended' };

  let record: GitHubTargetInstallation;
  try {
    record = await deps.api.getInstallation(input.installationId);
  } catch (error) {
    // The App has no record of that installation: it is not an installation of
    // our App, so the administrator may not approve it for the scanner.
    if (failureOf(error) === 'not_found') {
      return { ok: false, reason: 'installation_not_accessible' };
    }
    return { ok: false, reason: 'unverifiable' };
  }

  if (record.suspended) return { ok: false, reason: 'installation_suspended' };
  if (!record.issuesWrite) return { ok: false, reason: 'missing_issues_permission' };
  if (own.accountId !== null && own.accountId !== record.accountId) {
    return { ok: false, reason: 'account_mismatch' };
  }

  return { ok: true, githubAccountId: record.accountId };
}

/**
 * Picks the approved installation of the administrator that owns the repository.
 *
 * One approved installation is the one. With several, the account that owns the
 * repository decides: the account of the installation has to be the account the
 * administrator named. Nothing else is read, and the workspace an installation
 * happens to be linked to is never consulted.
 */
export async function selectApprovedInstallation(
  input: {
    adminUserId: string;
    owner: string;
    approvedInstallations: readonly WebScanApprovedInstallation[];
  },
  deps: GitHubTargetDeps,
): Promise<InstallationSelectionResult> {
  const own = input.approvedInstallations.filter(
    (entry) => entry.adminUserId === input.adminUserId,
  );
  const first = own[0];
  if (first === undefined) return { ok: false, reason: 'repository_not_approved' };
  if (own.length === 1) return { ok: true, approved: first };

  let unverifiable = false;
  for (const entry of own) {
    let record: GitHubTargetInstallation;
    try {
      record = await deps.api.getInstallation(entry.installationId);
    } catch (error) {
      if (failureOf(error) === 'not_found') continue;
      unverifiable = true;
      continue;
    }
    if (record.accountLogin.toLowerCase() === input.owner.toLowerCase()) {
      return { ok: true, approved: entry };
    }
  }
  if (unverifiable) return { ok: false, reason: 'unverifiable' };
  return { ok: false, reason: 'repository_not_approved' };
}

/**
 * Proves that a repository is a private target of an approved installation.
 *
 * The proof is: the App still has its record of the installation, the
 * installation grants `issues: write` and still belongs to the approved
 * account, the administrator sees the repository through that installation, the
 * installation sees the same repository, the repository is private and its
 * owner account is the approved one. The stored binding is what GitHub
 * reported, never what the request asked for.
 */
export async function verifyRepositoryTarget(
  input: {
    adminUserId: string;
    owner: string;
    name: string;
    approved: WebScanApprovedInstallation;
  },
  deps: GitHubTargetDeps,
): Promise<RepositoryTargetResult> {
  const token = await readAdminToken(deps, input.adminUserId);
  if (token === null) return { ok: false, reason: 'no_github_account' };

  let record: GitHubTargetInstallation;
  try {
    record = await deps.api.getInstallation(input.approved.installationId);
  } catch (error) {
    if (failureOf(error) === 'not_found') {
      return { ok: false, reason: 'installation_lost' };
    }
    return { ok: false, reason: 'unverifiable' };
  }
  if (record.suspended) return { ok: false, reason: 'installation_suspended' };
  if (!record.issuesWrite) return { ok: false, reason: 'missing_issues_permission' };
  if (record.accountId !== input.approved.githubAccountId) {
    return { ok: false, reason: 'account_mismatch' };
  }

  let repositories: GitHubTargetRepository[];
  try {
    repositories = await deps.api.listInstallationRepositories(
      token,
      input.approved.installationId,
    );
  } catch (error) {
    // The App has its own record of the installation, so a 404 of the listing
    // is a loss of the access of the administrator and not a deletion.
    if (failureOf(error) === 'not_found') {
      return { ok: false, reason: 'installation_not_accessible' };
    }
    return { ok: false, reason: 'unverifiable' };
  }
  const visible = findRepository(repositories, input.owner, input.name);
  if (visible === undefined) return { ok: false, reason: 'no_user_access' };

  let repository: GitHubTargetRepository;
  try {
    repository = await deps.api.getRepository(
      input.approved.installationId,
      input.owner,
      input.name,
    );
  } catch (error) {
    if (failureOf(error) === 'not_found') {
      return { ok: false, reason: 'repository_not_found' };
    }
    return { ok: false, reason: 'unverifiable' };
  }

  // The name alone is never the identity: the two views have to name the same
  // repository.
  if (repository.id !== visible.id) return { ok: false, reason: 'repository_not_found' };
  if (!repository.private || repository.visibility !== 'private') {
    return { ok: false, reason: 'not_private' };
  }
  if (repository.ownerAccountId !== input.approved.githubAccountId) {
    return { ok: false, reason: 'account_mismatch' };
  }

  return {
    ok: true,
    binding: {
      owner: repository.owner,
      name: repository.name,
      repositoryId: repository.id,
      installationId: input.approved.installationId,
      githubAccountId: repository.ownerAccountId,
    },
  };
}

/**
 * Re-checks a stored binding before a delivery (ADR-0052 section 8).
 *
 * The approval still has to exist for the same administrator, the administrator
 * still has to be a platform administrator, the repository id still has to
 * resolve to a private repository of the same account, the administrator still
 * has to reach it through their own GitHub access and the installation still
 * has to grant `issues: write`.
 */
export async function revalidateBinding(
  input: {
    adminUserId: string;
    binding: WebScanRepositoryBinding;
    approvedInstallations: readonly WebScanApprovedInstallation[];
    isAdminStillPlatformAdmin: boolean;
  },
  deps: GitHubTargetDeps,
): Promise<BindingRevalidationResult> {
  if (!input.isAdminStillPlatformAdmin) {
    return { ok: false, reason: 'admin_not_authorized' };
  }

  const approved = input.approvedInstallations.find(
    (entry) =>
      entry.adminUserId === input.adminUserId &&
      entry.installationId === input.binding.installationId &&
      entry.githubAccountId === input.binding.githubAccountId,
  );
  if (approved === undefined) return { ok: false, reason: 'approval_missing' };

  const token = await readAdminToken(deps, input.adminUserId);
  if (token === null) return { ok: false, reason: 'no_github_account' };

  let installations: UserInstallation[];
  try {
    installations = await deps.api.listUserInstallations(token);
  } catch {
    return { ok: false, reason: 'unverifiable' };
  }
  const own = installations.find((row) => row.id === input.binding.installationId);
  // The installation is not in the own list of the administrator. That proves
  // that the administrator lost the access to it, never that the installation
  // of the App is gone: the access can come back.
  if (own === undefined) return { ok: false, reason: 'installation_not_accessible' };
  if (own.suspended) return { ok: false, reason: 'installation_suspended' };

  let record: GitHubTargetInstallation;
  try {
    record = await deps.api.getInstallation(input.binding.installationId);
  } catch (error) {
    if (failureOf(error) === 'not_found') {
      return { ok: false, reason: 'installation_lost' };
    }
    return { ok: false, reason: 'unverifiable' };
  }
  if (record.suspended) return { ok: false, reason: 'installation_suspended' };
  if (!record.issuesWrite) return { ok: false, reason: 'missing_issues_permission' };
  if (record.accountId !== input.binding.githubAccountId) {
    return { ok: false, reason: 'account_mismatch' };
  }

  let repositories: GitHubTargetRepository[];
  try {
    repositories = await deps.api.listInstallationRepositories(
      token,
      input.binding.installationId,
    );
  } catch (error) {
    // The App has its own record of the installation, so a 404 of the listing
    // is a loss of the access of the administrator and not a deletion.
    if (failureOf(error) === 'not_found') {
      return { ok: false, reason: 'installation_not_accessible' };
    }
    return { ok: false, reason: 'unverifiable' };
  }
  const visible = findRepository(repositories, input.binding.owner, input.binding.name);
  if (visible === undefined) return { ok: false, reason: 'no_user_access' };

  let repository: GitHubTargetRepository;
  try {
    repository = await deps.api.getRepository(
      input.binding.installationId,
      input.binding.owner,
      input.binding.name,
    );
  } catch (error) {
    if (failureOf(error) === 'not_found') {
      return { ok: false, reason: 'repository_not_found' };
    }
    return { ok: false, reason: 'unverifiable' };
  }

  if (repository.id !== input.binding.repositoryId) {
    return { ok: false, reason: 'repository_not_found' };
  }
  if (!repository.private || repository.visibility !== 'private') {
    return { ok: false, reason: 'not_private' };
  }
  if (repository.ownerAccountId !== input.binding.githubAccountId) {
    return { ok: false, reason: 'account_mismatch' };
  }

  return { ok: true };
}

/** Binds the verification to the api and the token reader. */
export function createGitHubTargetVerifier(deps: GitHubTargetDeps): WebScanGitHubVerifier {
  return {
    approveInstallation: (input) => verifyInstallationApproval(input, deps),
    selectInstallation: (input) => selectApprovedInstallation(input, deps),
    verifyRepository: (input) => verifyRepositoryTarget(input, deps),
    revalidateBinding: (input) => revalidateBinding(input, deps),
  };
}

import type {
  BindingRevalidationResult,
  InstallationApprovalResult,
  InstallationSelectionResult,
  RepositoryTargetResult,
  WebScanGitHubVerifier,
} from '../webscan/github-target.js';
import type { WebScanApprovedInstallation, WebScanRepositoryBinding } from '../webscan/types.js';

/**
 * The shared fake of the GitHub boundary of the alert target (ADR-0052 section 8).
 *
 * The route tests never reach GitHub. The fake behaves like the real
 * verification on the happy path: the approved installation of the administrator
 * has to exist, and the binding it answers with is the one GitHub reported.
 */

export const TARGET_INSTALLATION_ID = 101;
export const TARGET_ACCOUNT_ID = 401;
export const TARGET_REPOSITORY_ID = 7;

/** The steps a test can refuse one at a time. */
export interface TargetVerifierOverrides {
  approveInstallation?: () => Promise<InstallationApprovalResult>;
  selectInstallation?: (input: {
    adminUserId: string;
    owner: string;
    approvedInstallations: readonly WebScanApprovedInstallation[];
  }) => Promise<InstallationSelectionResult>;
  verifyRepository?: (input: {
    adminUserId: string;
    owner: string;
    name: string;
    approved: WebScanApprovedInstallation;
  }) => Promise<RepositoryTargetResult>;
  revalidateBinding?: () => Promise<BindingRevalidationResult>;
}

/** The binding GitHub reported for a repository of the approved account. */
export function aTargetBinding(owner: string, name: string): WebScanRepositoryBinding {
  return {
    owner,
    name,
    repositoryId: TARGET_REPOSITORY_ID,
    installationId: TARGET_INSTALLATION_ID,
    githubAccountId: TARGET_ACCOUNT_ID,
  };
}

/** A verifier that proves everything, so a test can refuse one step at a time. */
export function aTargetVerifier(overrides: TargetVerifierOverrides = {}): WebScanGitHubVerifier {
  return {
    approveInstallation:
      overrides.approveInstallation ?? (async () => ({ ok: true, githubAccountId: TARGET_ACCOUNT_ID })),
    selectInstallation:
      overrides.selectInstallation ??
      (async ({ adminUserId, approvedInstallations }) => {
        const own = approvedInstallations.filter((entry) => entry.adminUserId === adminUserId);
        const first = own[0];
        if (first === undefined) return { ok: false, reason: 'repository_not_approved' };
        return { ok: true, approved: first };
      }),
    verifyRepository:
      overrides.verifyRepository ??
      (async ({ owner, name }) => ({ ok: true, binding: aTargetBinding(owner, name) })),
    revalidateBinding: overrides.revalidateBinding ?? (async () => ({ ok: true })),
  };
}

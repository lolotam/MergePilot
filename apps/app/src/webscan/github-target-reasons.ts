/**
 * The bounded reasons a GitHub target verification can fail with (ADR-0052 section 8).
 *
 * The list lives in its own leaf module, so the REST contract can share it
 * without dragging the GitHub boundary (and its database imports) into the
 * dashboard bundle.
 *
 * A reason is a fixed code, never a message of GitHub and never a value of a
 * credential. `installation_lost` and `repository_not_found` mean the target is
 * definitely gone; `unverifiable` means the proof could not be established at
 * all. Both answer the same way: the target is not approved.
 */
export const WEB_SCAN_GITHUB_TARGET_REASONS = [
  /** The administrator has no GitHub account of their own linked. */
  'no_github_account',
  /** The installation is not in the administrator's own list of installations. */
  'installation_not_accessible',
  /** The installation is suspended. */
  'installation_suspended',
  /** The installation does not grant the App `issues: write`. */
  'missing_issues_permission',
  /** The repository does not belong to the approved account (a transfer, for example). */
  'account_mismatch',
  /** The repository does not exist or the installation cannot see it. */
  'repository_not_found',
  /** The repository is public or internal. */
  'not_private',
  /** The administrator cannot reach the repository through the installation. */
  'no_user_access',
  /** The installation is gone. */
  'installation_lost',
  /** No approved installation of the administrator owns the repository. */
  'repository_not_approved',
  /** The approval of the installation is gone. */
  'approval_missing',
  /** The administrator is no longer a platform administrator. */
  'admin_not_authorized',
  /** GitHub cannot be reached or is not configured. */
  'github_unavailable',
  /** The proof could not be established. */
  'unverifiable',
] as const;

/** One bounded reason of a verification. */
export type WebScanGitHubTargetReason = (typeof WEB_SCAN_GITHUB_TARGET_REASONS)[number];

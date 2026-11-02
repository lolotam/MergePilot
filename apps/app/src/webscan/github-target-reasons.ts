/**
 * The bounded reasons a target request can be refused with (ADR-0052 section 8).
 *
 * The list lives in its own leaf module, so the REST contract can share it
 * without dragging the GitHub boundary (and its database imports) into the
 * dashboard bundle.
 *
 * A reason is a fixed code, never a message of GitHub and never a value of a
 * credential. Only `installation_lost` means the target is definitely gone: the
 * own record of the App of the installation answered 404. `repository_not_found`
 * also covers an installation that cannot see the repository, which is a
 * recoverable change and not a deletion, and `unverifiable` means the proof
 * could not be established at all. A loss of access is none of them: it is a
 * recoverable change of the authorization, and it answers the same way: the
 * target is not approved.
 */
export const WEB_SCAN_GITHUB_TARGET_REASONS = [
  /** The administrator has no GitHub account of their own linked. */
  'no_github_account',
  /**
   * The installation of the App is not reachable for the administrator.
   *
   * It is not in the own list of the administrator, the listing of its
   * repositories is not reachable for them, or the App has no own record of
   * it. None of them proves that the installation is gone: the access can come
   * back.
   */
  'installation_not_accessible',
  /** The installation is suspended. */
  'installation_suspended',
  /** The installation does not grant the App `issues: write`. */
  'missing_issues_permission',
  /** The repository does not belong to the approved account (a transfer, for example). */
  'account_mismatch',
  /**
   * The repository does not exist, or the installation cannot see it.
   *
   * The second case is a loss of access and not a deletion: the repository may
   * still be there for the account, and the access can come back.
   */
  'repository_not_found',
  /** The repository is public or internal. */
  'not_private',
  /**
   * The administrator cannot reach the repository through the installation.
   *
   * It is a loss of access and not a deletion: the repository may still be
   * there for the account.
   */
  'no_user_access',
  /** The own record of the App of the installation is gone: GitHub answered 404. */
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

/**
 * The bounded reasons a request for a target can be refused with.
 *
 * It holds every reason of the GitHub verification and one refusal of the
 * request itself: `not_site_owner` is not a verdict of GitHub, it is the
 * answer to a request that tries to bind the repository of a site without
 * being its owner.
 */
export const WEB_SCAN_TARGET_REFUSAL_REASONS = [
  ...WEB_SCAN_GITHUB_TARGET_REASONS,
  'not_site_owner',
] as const;

/** One bounded reason of a refused target request. */
export type WebScanTargetRefusalReason = (typeof WEB_SCAN_TARGET_REFUSAL_REASONS)[number];

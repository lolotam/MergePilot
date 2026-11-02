import { z } from 'zod';
import {
  WEB_SCAN_GITHUB_TARGET_REASONS,
  WEB_SCAN_TARGET_REFUSAL_REASONS,
} from '../webscan/github-target-reasons.js';

/**
 * The REST contract of the private target of an alert (ADR-0052 section 8).
 *
 * The target has its own module: the repository a site reports into, the
 * approval of an installation of the GitHub App and the refusal that a
 * verification answers with. The main scanner contract keeps the shapes of the
 * resources it already held, and one file cannot hold them all within the size
 * the linter allows.
 *
 * The request carries names, never ids. The ids of the repository, of the
 * installation and of the account are the server's answer, and they come from
 * GitHub.
 */

/**
 * The owner (login) of a GitHub account.
 *
 * GitHub logins are alphanumerics and hyphens, they never start or end with a
 * hyphen and they are at most 39 characters long.
 */
export const WebScanGitHubOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, {
    message: 'The owner must be a GitHub login',
  });
export type WebScanGitHubOwner = z.infer<typeof WebScanGitHubOwnerSchema>;

/** The name of a GitHub repository. */
export const WebScanGitHubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, {
    message: 'The name must be a GitHub repository name',
  });
export type WebScanGitHubRepositoryName = z.infer<typeof WebScanGitHubRepositoryNameSchema>;

/**
 * The repository a site reports into, as the administrator names it.
 *
 * The request carries the owner and the name only. The ids of the repository,
 * of the installation and of the account are the server's answer: they come
 * from GitHub, never from the request (ADR-0052 section 8).
 *
 * The dashboard sends `{ owner, name }` and nothing else: it displays the
 * stored binding and never writes an id, and every id of the binding is
 * derived server-side from GitHub.
 */
export const WebScanRepositoryRequestSchema = z.strictObject({
  owner: WebScanGitHubOwnerSchema,
  name: WebScanGitHubRepositoryNameSchema,
});
export type WebScanRepositoryRequest = z.infer<typeof WebScanRepositoryRequestSchema>;

/**
 * The installation an administrator approves.
 *
 * The body carries the installation only: the administrator comes from the
 * session and the account id comes from GitHub, so a caller cannot approve an
 * installation for another administrator or for another account.
 */
export const WebScanApprovedInstallationRequestSchema = z.strictObject({
  installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type WebScanApprovedInstallationRequest = z.infer<
  typeof WebScanApprovedInstallationRequestSchema
>;

/** The installation of the path of the removal. It is digits and nothing else. */
export const WebScanInstallationIdParamSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/, { message: 'The installation id must be digits' });
export type WebScanInstallationIdParam = z.infer<typeof WebScanInstallationIdParamSchema>;

/**
 * The bounded reasons a GitHub target verification can refuse with.
 *
 * They are the reason codes of ADR-0052 section 8: a refusal always names one
 * of them, and the message beside it is a fixed sentence that names no value of
 * GitHub and no credential.
 */
export const WebScanTargetReasonSchema = z.enum([...WEB_SCAN_GITHUB_TARGET_REASONS]);
export type WebScanTargetReason = z.infer<typeof WebScanTargetReasonSchema>;

/**
 * The bounded reasons a target request can be refused with.
 *
 * They hold every verdict of GitHub and the refusal of the request itself:
 * `not_site_owner` is not a verdict of GitHub, it is the answer to a request
 * that tries to bind the repository of a site without owning it.
 */
export const WebScanTargetRefusalReasonSchema = z.enum([...WEB_SCAN_TARGET_REFUSAL_REASONS]);
export type WebScanTargetRefusalReason = z.infer<typeof WebScanTargetRefusalReasonSchema>;

/** The body of a refused target: the bounded reason and a fixed safe message. */
export const WebScanTargetRefusedBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.literal('target_refused'),
    reason: WebScanTargetRefusalReasonSchema,
    message: z.string(),
  }),
});
export type WebScanTargetRefusedBody = z.infer<typeof WebScanTargetRefusedBodySchema>;

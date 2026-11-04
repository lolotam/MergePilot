import type { FastifyInstance, FastifyReply } from 'fastify';
import { sendError } from '../api/helpers.js';
import {
  WebScanApprovedInstallationRequestSchema,
  WebScanInstallationIdParamSchema,
} from '../api/contract-webscan-target.js';
import type { WebScanGitHubVerifier } from '../webscan/github-target.js';
import type { WebScanStore } from '../webscan/store.js';
import {
  sendWebScanTargetRefused,
  sendWebScanValidationError,
  webScanAdminId,
  withWebScanErrors,
  type WebScanAdminGuard,
} from './webscan-http.js';

/**
 * The approved-installation routes of the scanner (ADR-0052 section 8).
 *
 * An alert may only reach a private repository that the signed-in platform
 * administrator really reaches through an installation of OUR GitHub App. The
 * approval is the explicit, audited admin configuration action that says so, and
 * the server verifies it against GitHub before it is saved: the administrator
 * reaches the installation with their own GitHub account, the App has its own
 * record of it, the installation is not suspended and it grants `issues: write`.
 *
 * A verification that fails writes nothing and leaves no audit row behind: an
 * approval is never saved on a doubt.
 *
 * The administrator of the approval is the one of the session. The body carries
 * the installation only, so no caller can approve an installation for another
 * administrator or for another account.
 */

/** The dependencies of the approval routes. */
export interface WebScanApprovalRouteDeps {
  store: WebScanStore;
  /**
   * The GitHub boundary of the verification.
   *
   * It is absent in a deployment without a GitHub App and in the tests that do
   * not exercise the verification. A request that needs it is then refused: the
   * approval of an unverifiable installation is never saved.
   */
  github?: WebScanGitHubVerifier | undefined;
}

/** Reads and validates the installation of the path of the removal. */
function parseInstallationId(
  request: { params: unknown },
  reply: FastifyReply,
): number | FastifyReply {
  const raw = (request.params as Record<string, string>).installationId;
  const parsed = WebScanInstallationIdParamSchema.safeParse(raw);
  if (!parsed.success) {
    return sendWebScanValidationError(reply, parsed.error);
  }
  return Number(parsed.data);
}

export function registerWebScanApprovalsRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  deps: WebScanApprovalRouteDeps,
): void {
  app.post(
    '/api/admin/web-scan/settings/approved-installations',
    { preHandler: [guard] },
    async (request, reply) => {
      const adminId = webScanAdminId(request);
      if (adminId === undefined) {
        return sendError(reply, 404, 'not_found', 'Not found');
      }

      const parsed = WebScanApprovedInstallationRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendWebScanValidationError(reply, parsed.error);
      const installationId = parsed.data.installationId;

      if (deps.github === undefined) {
        return sendWebScanTargetRefused(reply, 'github_unavailable');
      }

      // The proof comes from GitHub, and the account id of the approval is the
      // one GitHub reports.
      const verified = await deps.github.approveInstallation({
        adminUserId: adminId,
        installationId,
      });
      if (!verified.ok) {
        return sendWebScanTargetRefused(reply, verified.reason);
      }

      const approved = await withWebScanErrors(reply, () =>
        deps.store.approveInstallation(adminId, {
          adminUserId: adminId,
          installationId,
          githubAccountId: verified.githubAccountId,
        }),
      );
      if (!approved.ok) return approved.reply;

      return reply.status(200).send({
        approvedInstallation: {
          adminUserId: adminId,
          installationId,
          githubAccountId: verified.githubAccountId,
        },
      });
    },
  );

  app.delete(
    '/api/admin/web-scan/settings/approved-installations/:installationId',
    { preHandler: [guard] },
    async (request, reply) => {
      const adminId = webScanAdminId(request);
      if (adminId === undefined) {
        return sendError(reply, 404, 'not_found', 'Not found');
      }

      const installationId = parseInstallationId(request, reply);
      if (typeof installationId !== 'number') return installationId;

      // Only the approval of the requesting administrator is removed, and
      // nothing else is detached: a site that points at the installation keeps
      // its binding and its delivery fails closed because the approval is gone.
      const revoked = await withWebScanErrors(reply, () =>
        deps.store.revokeInstallationApproval(adminId, adminId, installationId),
      );
      if (!revoked.ok) return revoked.reply;

      return reply.status(204).send();
    },
  );
}

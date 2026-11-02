import type { FastifyInstance } from 'fastify';
import { sendError } from '../api/helpers.js';
import {
  WebScanCreateExceptionSchema,
  WebScanExceptionsPageSchema,
  type WebScanExceptionDto,
} from '../api/contract-webscan.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanException } from '../webscan/types.js';
import {
  parseWebScanParam,
  sendWebScanNotFound,
  sendWebScanValidationError,
  webScanAdminId,
  withWebScanErrors,
  type WebScanAdminGuard,
} from './webscan-http.js';
import { parseSiteId } from './webscan-sites.js';
import { definedFields } from './webscan-params.js';

/**
 * The administrator resolutions of a site (ADR-0052 section 9).
 *
 * A resolution is recorded against an identity that was really observed: the store
 * answers a miss for an occurrence key and evidence hash that match no row. The
 * free-form reason is stored for the dashboard and the audit trail of the store; it
 * never reaches a log line, an event, a report or an export.
 *
 * The removal is the store's revocation: the resolution stops applying and the
 * occurrences it pinned go back to their unresolved state.
 */

/** Builds one resolution response from named fields; never a spread of the row. */
export function toWebScanExceptionDto(exception: WebScanException): WebScanExceptionDto {
  return {
    id: exception.id,
    siteId: exception.siteId,
    occurrenceKey: exception.occurrenceKey,
    evidenceHash: exception.evidenceHash,
    kind: exception.kind,
    reasonCategory: exception.reasonCategory,
    reason: exception.reason,
    expiresAt: exception.expiresAt === null ? null : exception.expiresAt.toISOString(),
    createdBy: exception.createdBy,
    createdAt: exception.createdAt.toISOString(),
    revokedAt: exception.revokedAt === null ? null : exception.revokedAt.toISOString(),
    revokedBy: exception.revokedBy,
  };
}

export function registerWebScanExceptionRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  store: WebScanStore,
): void {
  app.get(
    '/api/admin/web-scan/sites/:siteId/exceptions',
    { preHandler: [guard] },
    async (request, reply) => {
      if (webScanAdminId(request) === undefined) {
        return sendWebScanNotFound(reply);
      }
      const siteId = parseSiteId(request, reply);
      if (typeof siteId !== 'string') return siteId;

      // An unknown site is a miss, not an empty page.
      const site = await withWebScanErrors(reply, () => store.getSite(siteId));
      if (!site.ok) return site.reply;
      if (site.value === null) return sendWebScanNotFound(reply);

      const listed = await withWebScanErrors(reply, () => store.listExceptions(siteId));
      if (!listed.ok) return listed.reply;
      return reply.status(200).send(
        WebScanExceptionsPageSchema.parse({
          exceptions: listed.value.map((exception) => toWebScanExceptionDto(exception)),
        }),
      );
    },
  );

  app.post(
    '/api/admin/web-scan/sites/:siteId/exceptions',
    { preHandler: [guard] },
    async (request, reply) => {
      const adminId = webScanAdminId(request);
      if (adminId === undefined) {
        return sendWebScanNotFound(reply);
      }
      const siteId = parseSiteId(request, reply);
      if (typeof siteId !== 'string') return siteId;
      const parsed = WebScanCreateExceptionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendWebScanValidationError(reply, parsed.error);
      const body = parsed.data;

      // A resolution ends at a future moment or never. A resolution that already
      // ended would apply to nothing, so it is refused before anything is written.
      if (body.expiresAt !== undefined && body.expiresAt !== null) {
        const expiresAt = new Date(body.expiresAt);
        if (expiresAt.getTime() <= Date.now()) {
          return sendError(reply, 422, 'invalid_request', 'The expiry must be in the future');
        }
      }

      const created = await withWebScanErrors(reply, () =>
        store.createException(
          adminId,
          definedFields({
            siteId,
            occurrenceKey: body.occurrenceKey,
            evidenceHash: body.evidenceHash,
            kind: body.kind,
            reasonCategory: body.reasonCategory,
            reason: body.reason,
            expiresAt:
              body.expiresAt === undefined
                ? undefined
                : body.expiresAt === null
                  ? null
                  : new Date(body.expiresAt),
          }),
        ),
      );
      if (!created.ok) return created.reply;
      return reply.status(201).send(toWebScanExceptionDto(created.value));
    },
  );

  app.delete(
    '/api/admin/web-scan/sites/:siteId/exceptions/:exceptionId',
    { preHandler: [guard] },
    async (request, reply) => {
      const adminId = webScanAdminId(request);
      if (adminId === undefined) {
        return sendWebScanNotFound(reply);
      }
      const siteId = parseSiteId(request, reply);
      if (typeof siteId !== 'string') return siteId;
      const exceptionId = parseWebScanParam(request, reply, 'exceptionId');
      if (typeof exceptionId !== 'string') return exceptionId;

      // The resolution of another site is a miss here: no write touches a row that
      // the addressed site does not own. The id of the addressed site's own
      // resolutions decides, and an id that only exists elsewhere stays untouched.
      const listed = await withWebScanErrors(reply, () => store.listExceptions(siteId));
      if (!listed.ok) return listed.reply;
      if (!listed.value.some((exception) => exception.id === exceptionId)) {
        return sendWebScanNotFound(reply);
      }

      const revoked = await withWebScanErrors(reply, () => store.revokeException(adminId, exceptionId));
      if (!revoked.ok) return revoked.reply;
      return reply.status(200).send(toWebScanExceptionDto(revoked.value));
    },
  );
}

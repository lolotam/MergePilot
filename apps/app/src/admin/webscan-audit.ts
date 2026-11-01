import type { FastifyInstance } from 'fastify';
import { sendError } from '../api/helpers.js';
import {
  WebScanPageQuerySchema,
  type WebScanAuditEntryDto,
} from '../api/contract-webscan.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanAuditEntry } from '../webscan/types.js';
import {
  sendWebScanValidationError,
  webScanAdminId,
  type WebScanAdminGuard,
} from './webscan-http.js';

/**
 * The audit log route of the scanner (ADR-0052 section 10).
 *
 * The log is append-only: the store exposes no update and no delete, so the
 * route only reads. Entries come back newest first, one page of `limit`/`offset`
 * at a time. The history has no total: the store gives no count, and a page
 * that implies one would be a guess.
 */

/** Builds one response entry from named fields; the sanitized before/after pass verbatim. */
function toWebScanAuditDto(entry: WebScanAuditEntry): WebScanAuditEntryDto {
  return {
    id: entry.id,
    actor: entry.actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    before: entry.before,
    after: entry.after,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function registerWebScanAuditRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  store: WebScanStore,
): void {
  app.get('/api/admin/web-scan/audit', { preHandler: [guard] }, async (request, reply) => {
    if (webScanAdminId(request) === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const page = WebScanPageQuerySchema.safeParse(request.query ?? {});
    if (!page.success) return sendWebScanValidationError(reply, page.error);

    // The store reads the newest rows by a limit only, so the requested offset is
    // read past and sliced here; the rows never leave the store in another shape.
    const fetched = await store.listAudit({ limit: page.data.offset + page.data.limit });
    const entries = fetched
      .slice(page.data.offset, page.data.offset + page.data.limit)
      .map(toWebScanAuditDto);
    return reply.status(200).send({
      audit: entries,
      limit: page.data.limit,
      offset: page.data.offset,
    });
  });
}

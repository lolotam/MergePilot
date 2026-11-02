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
 * at a time. The page itself is read by the store, so a deep offset skips the
 * rows before it in the database instead of reading them and throwing them away.
 * The store reads the page and the total from one snapshot of the log, so a row
 * that is appended while the page is read can never make the page and the total
 * describe two versions of the log.
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

    // The store reads the page that was asked for and counts the log beside it in
    // one snapshot, so the rows and the total never describe two versions of the
    // log.
    const { entries, total } = await store.listAuditPage({
      limit: page.data.limit,
      offset: page.data.offset,
    });
    return reply.status(200).send({
      audit: entries.map(toWebScanAuditDto),
      total,
      limit: page.data.limit,
      offset: page.data.offset,
    });
  });
}

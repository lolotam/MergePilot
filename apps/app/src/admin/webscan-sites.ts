import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ScanScope } from '@mergepilot/webscan';
import { sendError } from '../api/helpers.js';
import {
  WebScanCoverageEntrySchema,
  WebScanCreateSiteSchema,
  WebScanIdSchema,
  WebScanPageQuerySchema,
  WebScanUpdateSiteSchema,
  type WebScanScopeInput,
  type WebScanSiteDto,
} from '../api/contract-webscan.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanSite } from '../webscan/types.js';
import {
  sendWebScanValidationError,
  webScanAdminId,
  withWebScanErrors,
  type WebScanAdminGuard,
} from './webscan-http.js';
import { definedFields, toStoreSchedule } from './webscan-params.js';
/**
 * The site routes of the scanner (ADR-0052 sections 1, 5 and 6).
 *
 * The administrator id of the session is both the owner and the authorizer of a
 * site it registers. A registration is an authorization act, so its body must
 * carry `authorize: true`, the fresh ownership/permission confirmation of
 * ADR-0052 section 1. A scope or schedule change needs the same confirmation,
 * mirroring the fresh manual confirmation of a scan. Removal is the store's
 * soft removal.
 */

type SiteIdParams = { siteId: string };

/** Reads and validates a `:siteId` param; a bad id is a request error, not a miss. */
export function parseSiteId(
  request: { params: unknown },
  reply: FastifyReply,
): string | FastifyReply {
  const parsed = WebScanIdSchema.safeParse((request.params as SiteIdParams).siteId);
  if (!parsed.success) {
    return sendWebScanValidationError(reply, parsed.error);
  }
  return parsed.data;
}

/** Merges the submitted scope with the site's canonical hostname and baseUrl. */
export function buildScope(hostname: string, baseUrl: string, input: WebScanScopeInput): ScanScope {
  return {
    hostname,
    baseUrl,
    crawlPaths: [...input.crawlPaths],
    blockedPaths: [...input.blockedPaths],
    parameterizedPaths: [...input.parameterizedPaths],
    activePaths: [...input.activePaths],
    extraFilePaths: [...input.extraFilePaths],
  };
}

/** Builds the response from named fields; never a spread of the site row. */
export function toWebScanSiteDto(site: WebScanSite): WebScanSiteDto {
  return {
    id: site.id,
    hostname: site.hostname,
    baseUrl: site.baseUrl,
    ownerUserId: site.ownerUserId,
    repository:
      site.repository === null
        ? null
        : {
            owner: site.repository.owner,
            name: site.repository.name,
            repositoryId: site.repository.repositoryId,
            installationId: site.repository.installationId,
            githubAccountId: site.repository.githubAccountId,
          },
    scope: {
      hostname: site.scope.hostname,
      baseUrl: site.scope.baseUrl,
      crawlPaths: site.scope.crawlPaths.map((rule) => ({ ...rule })),
      blockedPaths: site.scope.blockedPaths.map((rule) => ({ ...rule })),
      parameterizedPaths: site.scope.parameterizedPaths.map((rule) => ({
        path: rule.path,
        parameters: [...rule.parameters],
      })),
      activePaths: site.scope.activePaths.map((rule) => ({
        path: rule.path,
        parameters: [...rule.parameters],
      })),
      extraFilePaths: [...site.scope.extraFilePaths],
    },
    schedule: site.schedule === null ? null : { ...site.schedule },
    authorization: {
      auditId: site.authorization.auditId,
      authorizedBy: site.authorization.authorizedBy,
      authorizedAt:
        site.authorization.authorizedAt === null
          ? null
          : site.authorization.authorizedAt.toISOString(),
      scopeVersion: site.authorization.scopeVersion,
    },
    alertEpisodes: site.alertEpisodes.map((episode) => ({
      episodeKey: episode.episodeKey,
      issueKey: episode.issueKey,
      state: episode.state,
      occurrenceKeys: [...episode.occurrenceKeys],
      lastChangedAt: episode.lastChangedAt,
    })),
    lastCoverage:
      site.lastCoverage === null
        ? null
        : site.lastCoverage.map((entry) =>
            WebScanCoverageEntrySchema.parse({
              targetKey: entry.targetKey,
              checkId: entry.checkId,
              checkVersion: entry.checkVersion,
              evaluatedIssueIds: [...entry.evaluatedIssueIds],
              outcome: entry.outcome,
              reason: entry.reason ?? null,
            }),
          ),
    lastCoverageScanId: site.lastCoverageScanId,
    lastCoverageAt:
      site.lastCoverageAt === null ? null : site.lastCoverageAt.toISOString(),
    nextRunAt: site.nextRunAt === null ? null : site.nextRunAt.toISOString(),
    lastScanAt: site.lastScanAt === null ? null : site.lastScanAt.toISOString(),
    removedAt: site.removedAt === null ? null : site.removedAt.toISOString(),
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}

export function registerWebScanSitesRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  store: WebScanStore,
): void {
  app.get('/api/admin/web-scan/sites', { preHandler: [guard] }, async (request, reply) => {
    if (webScanAdminId(request) === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const page = WebScanPageQuerySchema.safeParse(request.query ?? {});
    if (!page.success) return sendWebScanValidationError(reply, page.error);

    const sites = await store.listSites();
    const items = sites.slice(page.data.offset, page.data.offset + page.data.limit);
    return reply.status(200).send({
      sites: items.map((site) => toWebScanSiteDto(site)),
      total: sites.length,
      limit: page.data.limit,
      offset: page.data.offset,
    });
  });

  app.post('/api/admin/web-scan/sites', { preHandler: [guard] }, async (request, reply) => {
    const adminId = webScanAdminId(request);
    if (adminId === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const parsed = WebScanCreateSiteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendWebScanValidationError(reply, parsed.error);
    const body = parsed.data;

    const created = await withWebScanErrors(reply, () =>
      store.createSite(
        adminId,
        definedFields({
          hostname: body.hostname,
          baseUrl: body.baseUrl,
          ownerUserId: adminId,
          scope: buildScope(body.hostname, body.baseUrl, body.scope),
          schedule: toStoreSchedule(body.schedule),
          repository: body.repository ?? undefined,
          authorizedBy: adminId,
        }),
      ),
    );
    if (!created.ok) return created.reply;
    return reply.status(201).send(toWebScanSiteDto(created.value));
  });

  app.get('/api/admin/web-scan/sites/:siteId', { preHandler: [guard] }, async (request, reply) => {
    if (webScanAdminId(request) === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const siteId = parseSiteId(request, reply);
    if (typeof siteId !== 'string') return siteId;

    const site = await withWebScanErrors(reply, () => store.getSite(siteId));
    if (!site.ok) return site.reply;
    if (site.value === null) return sendError(reply, 404, 'not_found', 'Not found');
    return reply.status(200).send(toWebScanSiteDto(site.value));
  });

  app.patch('/api/admin/web-scan/sites/:siteId', { preHandler: [guard] }, async (request, reply) => {
    const adminId = webScanAdminId(request);
    if (adminId === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const siteId = parseSiteId(request, reply);
    if (typeof siteId !== 'string') return siteId;
    const parsed = WebScanUpdateSiteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendWebScanValidationError(reply, parsed.error);
    const body = parsed.data;

    if ((body.scope !== undefined || body.schedule !== undefined) && body.authorize !== true) {
      return sendError(
        reply,
        422,
        'confirmation_required',
        'A change of the scope or of the schedule needs a fresh authorization confirmation',
      );
    }

    const current = await withWebScanErrors(reply, () => store.getSite(siteId));
    if (!current.ok) return current.reply;
    if (current.value === null) return sendError(reply, 404, 'not_found', 'Not found');
    const input = definedFields({
      scope:
        body.scope === undefined
          ? undefined
          : buildScope(current.value.scope.hostname, current.value.scope.baseUrl, body.scope),
      schedule: toStoreSchedule(body.schedule),
      repository: body.repository ?? undefined,
      authorizedBy: body.authorize === true ? adminId : undefined,
    });
    const updated = await withWebScanErrors(reply, () => store.updateSite(adminId, siteId, input));
    if (!updated.ok) return updated.reply;
    return reply.status(200).send(toWebScanSiteDto(updated.value));
  });

  app.delete('/api/admin/web-scan/sites/:siteId', { preHandler: [guard] }, async (request, reply) => {
    const adminId = webScanAdminId(request);
    if (adminId === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const siteId = parseSiteId(request, reply);
    if (typeof siteId !== 'string') return siteId;

    const removed = await withWebScanErrors(reply, () => store.removeSite(adminId, siteId));
    if (!removed.ok) return removed.reply;
    return reply.status(200).send(toWebScanSiteDto(removed.value));
  });
}

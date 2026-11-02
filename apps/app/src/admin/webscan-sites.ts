import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ScanScope } from '@mergepilot/webscan';
import { sendError } from '../api/helpers.js';
import {
  WebScanCoverageEntrySchema,
  WebScanIdSchema,
  WebScanPageQuerySchema,
  type WebScanScopeInput,
} from '../api/contract-webscan.js';
import {
  WebScanCreateSiteSchema,
  WebScanUpdateSiteSchema,
  type WebScanSiteDto,
} from '../api/contract-webscan-site.js';
import type { WebScanGitHubVerifier } from '../webscan/github-target.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanRepositoryBinding, WebScanSite } from '../webscan/types.js';
import {
  sendWebScanTargetRefused,
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
 *
 * The repository of a site is server-derived: the request names the owner and
 * the name, and the server asks GitHub for the ids of the repository, of the
 * installation and of the account before it stores them. A repository that GitHub
 * cannot prove private and reachable is refused, and nothing is written.
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
      // The state the alert engine added later is optional: an episode that
      // never carried a field keeps it absent instead of naming a state it
      // never had.
      ...(episode.issueState === undefined ? {} : { issueState: episode.issueState }),
      ...(episode.issueRequested === undefined ? {} : { issueRequested: episode.issueRequested }),
      ...(episode.resolved === undefined ? {} : { resolved: episode.resolved }),
      ...(episode.outcome === undefined ? {} : { outcome: episode.outcome }),
      ...(episode.severity === undefined ? {} : { severity: episode.severity }),
      ...(episode.validation === undefined ? {} : { validation: episode.validation }),
      ...(episode.generation === undefined ? {} : { generation: episode.generation }),
      ...(episode.createdAt === undefined ? {} : { createdAt: episode.createdAt }),
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

/** The dependencies of the site routes. */
export interface WebScanSiteRouteDeps {
  store: WebScanStore;
  /**
   * The GitHub boundary of the repository verification.
   *
   * It is absent in a deployment without a GitHub App and in the tests that do
   * not exercise the verification. A request that names a repository is then
   * refused: an unverified repository is never stored.
   */
  github?: WebScanGitHubVerifier | undefined;
}

/**
 * Resolves the repository a site reports into.
 *
 * The approved installation of the administrator that owns the repository is
 * picked first, and the repository is then proved against it by GitHub. The
 * binding that comes back is what GitHub reported: the ids of the request are
 * never used, because the request does not carry any.
 */
async function resolveRepositoryBinding(
  deps: WebScanSiteRouteDeps,
  reply: FastifyReply,
  adminId: string,
  requested: { owner: string; name: string },
): Promise<{ ok: true; binding: WebScanRepositoryBinding } | { ok: false; reply: FastifyReply }> {
  if (deps.github === undefined) {
    return { ok: false, reply: sendWebScanTargetRefused(reply, 'github_unavailable') };
  }

  const settings = await withWebScanErrors(reply, () => deps.store.getSettings());
  if (!settings.ok) return { ok: false, reply: settings.reply };

  // The approval can be gone before the binding is written: the delivery then
  // fails closed and the revalidation before every write proves it again.
  const selected = await deps.github.selectInstallation({
    adminUserId: adminId,
    owner: requested.owner,
    approvedInstallations: settings.value.approvedInstallations,
  });
  if (!selected.ok) {
    return { ok: false, reply: sendWebScanTargetRefused(reply, selected.reason) };
  }

  const verified = await deps.github.verifyRepository({
    adminUserId: adminId,
    owner: requested.owner,
    name: requested.name,
    approved: selected.approved,
  });
  if (!verified.ok) {
    return { ok: false, reply: sendWebScanTargetRefused(reply, verified.reason) };
  }

  return { ok: true, binding: verified.binding };
}

export function registerWebScanSitesRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  deps: WebScanSiteRouteDeps,
): void {
  const store = deps.store;

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

    // A named repository is proved by GitHub before the site is registered, so
    // a refused repository leaves neither a site nor an audit row behind.
    let repository: WebScanRepositoryBinding | undefined;
    if (body.repository !== undefined && body.repository !== null) {
      const resolved = await resolveRepositoryBinding(deps, reply, adminId, body.repository);
      if (!resolved.ok) return resolved.reply;
      repository = resolved.binding;
    }

    const created = await withWebScanErrors(reply, () =>
      store.createSite(
        adminId,
        definedFields({
          hostname: body.hostname,
          baseUrl: body.baseUrl,
          ownerUserId: adminId,
          scope: buildScope(body.hostname, body.baseUrl, body.scope),
          schedule: toStoreSchedule(body.schedule),
          repository,
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
    const parsed = WebScanUpdateSiteSchema.safeParse(request.body);
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

    // A named repository is proved by GitHub before it is stored, and a null one
    // unlinks the site without any proof: the binding is simply gone.
    //
    // Only the owner of the site may bind a repository to it: the alerts of the
    // site are delivered as that administrator, so the binding has to be backed
    // by them (ADR-0052 section 8). Every platform administrator may unlink the
    // site instead, because an unlink removes a target and never adds one.
    let repository: WebScanRepositoryBinding | null | undefined;
    if (body.repository !== undefined) {
      if (body.repository === null) {
        repository = null;
      } else {
        if (current.value.ownerUserId !== adminId) {
          return sendWebScanTargetRefused(reply, 'not_site_owner');
        }
        const resolved = await resolveRepositoryBinding(deps, reply, adminId, body.repository);
        if (!resolved.ok) return resolved.reply;
        repository = resolved.binding;
      }
    }

    const input = definedFields({
      scope:
        body.scope === undefined
          ? undefined
          : buildScope(current.value.scope.hostname, current.value.scope.baseUrl, body.scope),
      schedule: toStoreSchedule(body.schedule),
      // A null repository unlinks the site and an absent one leaves the binding
      // alone, so the null reaches the store instead of being turned into an
      // absent field.
      repository,
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

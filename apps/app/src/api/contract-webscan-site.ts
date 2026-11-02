import { z } from 'zod';
import {
  WebScanAlertEpisodeSchema,
  WebScanBaseUrlSchema,
  WebScanCoverageEntrySchema,
  WebScanHostnameSchema,
  WebScanRepositorySchema,
  WebScanScheduleSchema,
  WebScanScopeInputSchema,
  WebScanScopeSchema,
} from './contract-webscan.js';

/**
 * The REST contract of the sites of the platform-admin website security scan
 * (ADR-0052 sections 1, 5 and 6).
 *
 * The sites have their own module: the contract of the scanner holds the schemas of
 * every other resource, and one file cannot hold them all within the size the
 * linter allows. The module reads the shared schemas of the contract and the
 * contract never reads this one, so the two never depend on each other.
 */

/** GET/POST /api/admin/web-scan/sites and GET/PATCH/DELETE /api/admin/web-scan/sites/:siteId. */
export const WebScanSiteDtoSchema = z.strictObject({
  id: z.string(),
  hostname: z.string(),
  baseUrl: z.string(),
  ownerUserId: z.string(),
  repository: WebScanRepositorySchema.nullable(),
  scope: WebScanScopeSchema,
  schedule: WebScanScheduleSchema.nullable(),
  authorization: z.strictObject({
    auditId: z.string().nullable(),
    authorizedBy: z.string().nullable(),
    authorizedAt: z.string().nullable(),
    scopeVersion: z.number(),
  }),
  alertEpisodes: z.array(WebScanAlertEpisodeSchema),
  lastCoverage: z.array(WebScanCoverageEntrySchema).nullable(),
  lastCoverageScanId: z.string().nullable(),
  lastCoverageAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastScanAt: z.string().nullable(),
  removedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebScanSiteDto = z.infer<typeof WebScanSiteDtoSchema>;

/**
 * POST /api/admin/web-scan/sites — registration carries a fresh authorization.
 *
 * `authorize: true` is the fresh ownership/permission confirmation of ADR-0052
 * section 1: a registration without it is refused before anything is written.
 * The field is contract-only and never reaches the store.
 *
 * The base URL has to name the hostname of the site and to use its default port:
 * a base URL of another host would point the scanner at a host the site list does
 * not hold, and a port would point it at another service of the same host. A path
 * is allowed, because the scanner may start from a path inside the site.
 */
export const WebScanCreateSiteSchema = z
  .strictObject({
    hostname: WebScanHostnameSchema,
    baseUrl: WebScanBaseUrlSchema,
    scope: WebScanScopeInputSchema,
    schedule: WebScanScheduleSchema.nullable().optional(),
    repository: WebScanRepositorySchema.nullable().optional(),
    authorize: z.literal(true, {
      message: 'A registration needs an explicit authorization confirmation',
    }),
  })
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value.baseUrl);
    } catch {
      // The base URL rule already refused it.
      return;
    }
    // The URL parser lowercases the host and the hostname rule only accepts a
    // lowercase host name, so the two are compared as they are.
    if (parsed.hostname !== value.hostname) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'The baseUrl must name the hostname of the site',
      });
      return;
    }
    if (parsed.port !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'The baseUrl must use the default port',
      });
    }
  });
export type WebScanCreateSiteRequest = z.infer<typeof WebScanCreateSiteSchema>;

/**
 * PATCH /api/admin/web-scan/sites/:siteId.
 *
 * A scope or schedule change needs `authorize: true`: the request itself is the
 * fresh ownership/permission confirmation of ADR-0052 section 1 and is audited as
 * one. The schedule is never cleared to null; it is switched off with `enabled: false`.
 *
 * A patch that carries no change is refused: it would write a change and an audit
 * row for a request that asked for nothing. The confirmation alone is not a change
 * either: it only confirms the change that carries it.
 */
export const WebScanUpdateSiteSchema = z
  .strictObject({
    scope: WebScanScopeInputSchema.optional(),
    schedule: WebScanScheduleSchema.optional(),
    repository: WebScanRepositorySchema.nullable().optional(),
    authorize: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.scope !== undefined ||
      value.schedule !== undefined ||
      value.repository !== undefined,
    { message: 'The patch must carry at least one change' },
  );
export type WebScanUpdateSiteRequest = z.infer<typeof WebScanUpdateSiteSchema>;

/** GET /api/admin/web-scan/sites — an offset page over the registered sites. */
export const WebScanSitesPageSchema = z.strictObject({
  sites: z.array(WebScanSiteDtoSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type WebScanSitesPage = z.infer<typeof WebScanSitesPageSchema>;

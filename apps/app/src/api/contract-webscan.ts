import { z } from 'zod';
import { SCAN_LIMIT_FIELDS, SCAN_LIMIT_SPECS } from '@mergepilot/webscan';

/**
 * REST contract of the platform-admin website security scan (ADR-0052).
 *
 * The admin routes (apps/app/src/admin) and the web UI build against these shapes.
 * Every id and body is validated here, and unknown keys are rejected, so no raw
 * driver or store failure is ever needed to explain a bad request. Error bodies
 * use the admin envelope `{ error: { code, message } }`.
 */

/** The bounded error codes of the scanner routes. */
export const WebScanErrorCodeSchema = z.enum([
  'not_found',
  'conflict',
  'paused',
  'authorization_required',
  'invalid_request',
  'confirmation_required',
  'too_many_streams',
  'live_updates_unavailable',
]);
export type WebScanErrorCode = z.infer<typeof WebScanErrorCodeSchema>;

export const WebScanErrorBodySchema = z.object({
  error: z.object({ code: WebScanErrorCodeSchema, message: z.string() }),
});
export type WebScanErrorBody = z.infer<typeof WebScanErrorBodySchema>;

/** Validation, schedule and settings errors all answer 422 with this stable code. */
export const WEB_SCAN_INVALID_REQUEST_CODE = 'invalid_request' as const;

/** True only for `ScannerMaintenanceRunId`-style uuid store ids (migration 0019). */
export const WebScanIdSchema = z.string().uuid({ message: 'The id is not a valid uuid' });
export type WebScanId = z.infer<typeof WebScanIdSchema>;

/** A keyed identity digest: HMAC-SHA-256 hex of an occurrence or a body digest. */
export const WebScanDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'The digest must be 64 lowercase hex characters',
});

/**
 * An ISO 8601 timestamp in a request body.
 *
 * The moment has to exist: the validator refuses an impossible calendar date
 * (a 13th month, a 30th of February) and an hour that never came, and it wants
 * the offset of the zone (`Z` or `+03:00`) so the moment is unambiguous.
 */
export const WebScanIsoTimestampSchema = z.string().datetime({
  offset: true,
  message: 'The timestamp must be written as ISO 8601',
});

/** The lowercased host name a site matches exactly (no scheme, no path, no query). */
export const WebScanHostnameSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
    message: 'The hostname must be a lowercase host name',
  });
export type WebScanHostname = z.infer<typeof WebScanHostnameSchema>;

/**
 * The query-free base URL a scan starts from. userinfo, query and fragment are refused.
 *
 * It is the base of the site and not only its origin: a path is allowed, because the
 * scanner may start from a path inside the site. The host of the URL has to be the
 * hostname of the site, and the URL has to use the default port; both are checked
 * where the site is registered.
 */
export const WebScanBaseUrlSchema = z
  .string()
  .max(300)
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      return (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.search === '' &&
        parsed.hash === ''
      );
    },
    { message: 'The baseUrl must be an http(s) origin without credentials, query or fragment' },
  );
export type WebScanBaseUrl = z.infer<typeof WebScanBaseUrlSchema>;

/** One crawl path rule. The path is a stored unit; the scanner re-checks its shape. */
export const WebScanPathRuleSchema = z.strictObject({
  path: z.string().max(1024).regex(/^\//, { message: 'The path must start with /' }),
  kind: z.enum(['exact', 'prefix']),
});
export type WebScanPathRule = z.infer<typeof WebScanPathRuleSchema>;

/** One parameterized-link authorization: an exact path and its parameter names. */
export const WebScanParameterRuleSchema = z.strictObject({
  path: z.string().max(1024).regex(/^\//, { message: 'The path must start with /' }),
  parameters: z.array(z.string().max(200)).max(30),
});
export type WebScanParameterRule = z.infer<typeof WebScanParameterRuleSchema>;

/** The authorized scope an administrator submits. The hostname and baseUrl of the site are injected. */
export const WebScanScopeInputSchema = z.strictObject({
  crawlPaths: z.array(WebScanPathRuleSchema).max(200),
  blockedPaths: z.array(WebScanPathRuleSchema).max(200),
  parameterizedPaths: z.array(WebScanParameterRuleSchema).max(100),
  activePaths: z.array(WebScanParameterRuleSchema).max(100),
  extraFilePaths: z.array(z.string().max(1024).regex(/^\//)).max(200),
});
export type WebScanScopeInput = z.infer<typeof WebScanScopeInputSchema>;

/** The scope as stored on the site, with the injected hostname and baseUrl. */
export const WebScanScopeSchema = WebScanScopeInputSchema.extend({
  hostname: z.string(),
  baseUrl: z.string(),
});
export type WebScanScope = z.infer<typeof WebScanScopeSchema>;

/** The private repository a site reports into. */
export const WebScanRepositorySchema = z.strictObject({
  owner: z.string().max(200),
  name: z.string().max(200),
  repositoryId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  githubAccountId: z.number().int().positive(),
});
export type WebScanRepository = z.infer<typeof WebScanRepositorySchema>;

/** A schedule rule. The frequency decides which optional field is required. */
export const WebScanScheduleSchema = z.strictObject({
  frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
  weekday: z.number().int().min(0, { message: 'The weekday starts at 0 (Sunday)' }).max(6).optional(),
  dayOfMonth: z
    .number()
    .int()
    .min(1, { message: 'The day of the month starts at 1' })
    .max(31)
    .optional(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  enabled: z.boolean(),
  anchorDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'The anchor date must be written as YYYY-MM-DD' })
    .optional(),
});
export type WebScanSchedule = z.infer<typeof WebScanScheduleSchema>;

/** One limit value, bounded by the immutable `SCAN_LIMIT_SPECS` table. */
function limitField(field: keyof typeof SCAN_LIMIT_SPECS) {
  const spec = SCAN_LIMIT_SPECS[field];
  return z
    .number()
    .int()
    .min(spec.min, { message: `${field} is below its minimum` })
    .max(spec.max, { message: `${field} is above its ceiling` });
}

/** The effective limits of the scanner, as the store returns them. */
export const WebScanLimitsSchema = z.strictObject({
  maxRequests: limitField('maxRequests'),
  maxPages: limitField('maxPages'),
  maxActiveLinks: limitField('maxActiveLinks'),
  requestsPerSecond: limitField('requestsPerSecond'),
  requestTimeoutMs: limitField('requestTimeoutMs'),
  maxResponseBytes: limitField('maxResponseBytes'),
  totalTimeoutMs: limitField('totalTimeoutMs'),
});
export type WebScanLimits = z.infer<typeof WebScanLimitsSchema>;

/** Only the limit fields a change writes. Every value is still bounded. */
export const WebScanLimitsPatchSchema = WebScanLimitsSchema.partial();
export type WebScanLimitsPatch = z.infer<typeof WebScanLimitsPatchSchema>;

/** The names of the limit fields, as the confirmation lists them. */
export const WebScanLimitFieldSchema = z.enum(SCAN_LIMIT_FIELDS);
export type WebScanLimitField = z.infer<typeof WebScanLimitFieldSchema>;

/**
 * The 422 body of a limits change that still needs its confirmation.
 *
 * The dashboard runs in a browser and cannot compute the digest of the
 * effective limits, so the server hands it back: `digest` is the digest of the
 * effective submitted limits and `fieldsAboveDefault` names the limit fields
 * that are above their default. The administrator confirms those fields, and
 * the dashboard re-sends the same patch with `limitConfirmation: { digest }`.
 *
 * `effectiveLimits` is the whole effective limits the digest was computed
 * from: the stored row with the submitted fields on top. The dashboard shows
 * those exact values in the confirmation, so it never confirms a digest of a
 * set of values other than the one it shows (the row of the server may have
 * moved since the dashboard read it).
 *
 * This is the body of the above-default confirmation only. The other
 * `confirmation_required` answers (the site scope and schedule one) carry no
 * digest, so they keep the plain `WebScanErrorBodySchema` shape.
 */
export const WebScanConfirmationRequiredBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.literal('confirmation_required'),
    message: z.string(),
    digest: WebScanDigestSchema,
    fieldsAboveDefault: z.array(WebScanLimitFieldSchema),
    effectiveLimits: WebScanLimitsSchema,
  }),
});
export type WebScanConfirmationRequiredBody = z.infer<
  typeof WebScanConfirmationRequiredBodySchema
>;

/** The six catalogue checks of ADR-0052 section 3. */
export const WebScanChecksSchema = z.strictObject({
  headers: z.boolean(),
  cookies: z.boolean(),
  transport: z.boolean(),
  disclosure: z.boolean(),
  files: z.boolean(),
  active: z.boolean(),
});
export type WebScanChecks = z.infer<typeof WebScanChecksSchema>;

/** One approved (administrator, installation, account) alert binding. */
export const WebScanApprovedInstallationSchema = z.strictObject({
  adminUserId: z.string().min(1).max(64),
  installationId: z.number().int().positive(),
  githubAccountId: z.number().int().positive(),
});
export type WebScanApprovedInstallation = z.infer<typeof WebScanApprovedInstallationSchema>;

/**
 * PATCH /api/admin/web-scan/settings.
 *
 * Mirrors the store's `WebScanSettingsPatch` field for field, plus the
 * confirmation the ADR-0052 section 5 requires when an effective limit value
 * rises above its default: `limitConfirmation.digest` must be the digest of the
 * effective submitted limits (see `limitsConfirmationDigest`).
 *
 * A patch that carries no setting to change is refused: it would write a change and
 * an audit row for a request that asked for nothing. The confirmation alone is not a
 * change either: it only confirms the values of the patch that carries it.
 *
 * The approved-installation list is read-only here: ADR-0052 section 8 requires
 * every binding to be verified against GitHub before it is saved, and the
 * verifying endpoint arrives with Task 10. Until it exists, a body that carries
 * `approvedInstallations` is refused as an unknown key and nothing is written.
 */
export const WebScanSettingsPatchSchema = z
  .strictObject({
    paused: z.boolean().optional(),
    alertsEnabled: z.boolean().optional(),
    limits: WebScanLimitsPatchSchema.optional(),
    checks: WebScanChecksSchema.optional(),
    defaultSchedule: WebScanScheduleSchema.optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    contact: z.string().max(200).optional(),
    alertMinSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
    alertMinValidation: z.enum(['Confirmed', 'Likely', 'Indicator', 'Informational']).optional(),
    limitConfirmation: z.strictObject({ digest: WebScanDigestSchema }).optional(),
  })
  .refine(
    (value) => {
      // An empty `limits` object changes nothing, just like the confirmation alone.
      const changesLimits = value.limits !== undefined && Object.keys(value.limits).length > 0;
      const changesOther = Object.keys(value).some(
        (key) => key !== 'limitConfirmation' && key !== 'limits',
      );
      return changesLimits || changesOther;
    },
    { message: 'The patch must carry at least one setting to change' },
  );
export type WebScanSettingsPatchRequest = z.infer<typeof WebScanSettingsPatchSchema>;

/** GET and PATCH /api/admin/web-scan/settings — the effective global policy. */
export const WebScanSettingsDtoSchema = z.strictObject({
  paused: z.boolean(),
  alertsEnabled: z.boolean(),
  limits: WebScanLimitsSchema,
  checks: WebScanChecksSchema,
  defaultSchedule: WebScanScheduleSchema,
  retentionDays: z.number(),
  contact: z.string(),
  alertMinSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  alertMinValidation: z.enum(['Confirmed', 'Likely', 'Indicator', 'Informational']),
  approvedInstallations: z.array(WebScanApprovedInstallationSchema),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type WebScanSettingsDto = z.infer<typeof WebScanSettingsDtoSchema>;

/** One coverage row of a scan or of the retained site coverage. */
export const WebScanCoverageEntrySchema = z.strictObject({
  targetKey: z.string(),
  checkId: z.enum(['headers', 'cookies', 'transport', 'disclosure', 'files', 'active']),
  checkVersion: z.number(),
  evaluatedIssueIds: z.array(z.string()),
  outcome: z.enum(['checked', 'error', 'not-visited']),
  reason: z
    .enum(['redirect_out_of_scope', 'http_probe_unreachable', 'disabled', 'not_visited', 'target_error'])
    .nullable(),
});
export type WebScanCoverageEntryDto = z.infer<typeof WebScanCoverageEntrySchema>;

/** One alert episode of a site: bounded state, keyed by issue. */
export const WebScanAlertEpisodeSchema = z.strictObject({
  episodeKey: z.string(),
  issueKey: z.string(),
  state: z.enum(['open', 'closed']),
  occurrenceKeys: z.array(z.string()),
  lastChangedAt: z.string(),
});

/** GET /api/admin/web-scan/sites — the schemas of the sites live in their own module. */

/** The lifecycle of a scan. */
export const WebScanScanStatusSchema = z.enum(['queued', 'running', 'completed', 'stopped', 'failed']);
export type WebScanScanStatus = z.infer<typeof WebScanScanStatusSchema>;

/** How a scan was queued. */
export const WebScanTriggerSchema = z.enum(['manual', 'scheduled']);

/**
 * GET /scans/:scanId and the scan lists. The internal lock/lease columns
 * (attempt id, heartbeat, outbox state, idempotency key) never leave the store.
 */
export const WebScanScanDtoSchema = z.strictObject({
  id: z.string(),
  siteId: z.string(),
  trigger: WebScanTriggerSchema,
  status: WebScanScanStatusSchema,
  scheduledFor: z.string().nullable(),
  requests: z.number(),
  pages: z.number(),
  durationMs: z.number(),
  stopReason: z.string().nullable(),
  failReason: z.string().nullable(),
  coverageSummary: z.array(WebScanCoverageEntrySchema).nullable(),
  authorizationAuditId: z.string().nullable(),
  scopeVersion: z.number(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type WebScanScanDto = z.infer<typeof WebScanScanDtoSchema>;

/**
 * POST /api/admin/web-scan/sites/:siteId/scans — a manual scan with its idempotency key.
 *
 * `authorize: true` is the fresh confirmation the manual request itself is (ADR-0052
 * sections 1 and 6): an enqueue without it is refused before anything is queued. The
 * field is contract-only and never reaches the store.
 */
export const WebScanEnqueueManualSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(8).max(128),
  scope: WebScanScopeInputSchema.optional(),
  checks: WebScanChecksSchema.optional(),
  authorize: z.literal(true, {
    message: 'A manual scan needs a fresh authorization confirmation',
  }),
});
export type WebScanEnqueueManualRequest = z.infer<typeof WebScanEnqueueManualSchema>;

/** The outcome of a manual enqueue; a replayed request reuses its existing scan. */
export const WebScanEnqueueResultSchema = z.strictObject({
  scan: WebScanScanDtoSchema,
  replayed: z.boolean(),
});
export type WebScanEnqueueResult = z.infer<typeof WebScanEnqueueResultSchema>;

/** GET /api/admin/web-scan/sites/:siteId/scans — an offset page of scan history. */
export const WebScanScansPageSchema = z.strictObject({
  scans: z.array(WebScanScanDtoSchema),
  limit: z.number(),
  offset: z.number(),
});
export type WebScanScansPage = z.infer<typeof WebScanScansPageSchema>;

/** One retained occurrence of the ledger as the scan detail prints it. */
export const WebScanOccurrenceDtoSchema = z.strictObject({
  id: z.string(),
  occurrenceKey: z.string(),
  targetKey: z.string(),
  issueKey: z.string(),
  checkId: z.enum(['headers', 'cookies', 'transport', 'disclosure', 'files', 'active']),
  checkVersion: z.number(),
  issueId: z.string(),
  subject: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  validation: z.enum(['Confirmed', 'Likely', 'Indicator', 'Informational']),
  confidence: z.enum(['high', 'medium', 'low']),
  safeLocation: z.string(),
  evidenceHash: z.string(),
  evidence: z.unknown(),
  state: z.enum(['outstanding', 'fixed', 'archived']),
  archiveReason: z.enum(['unobserved_retention', 'retired_catalogue']).nullable(),
  comparison: z.enum(['New', 'Unchanged', 'Fixed', 'Not checked']).nullable(),
  exceptionId: z.string().nullable(),
  lastObservedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebScanOccurrenceDto = z.infer<typeof WebScanOccurrenceDtoSchema>;

/** GET /api/admin/web-scan/scans/:scanId — state, coverage and the ledger. */
export const WebScanScanDetailSchema = z.strictObject({
  scan: WebScanScanDtoSchema,
  coverage: z.array(WebScanCoverageEntrySchema),
  occurrences: z.array(WebScanOccurrenceDtoSchema),
});
export type WebScanScanDetail = z.infer<typeof WebScanScanDetailSchema>;

/** POST /api/admin/web-scan/scans/:scanId/stop — idempotent cancellation. */
export const WebScanStopResultSchema = z.strictObject({ scan: WebScanScanDtoSchema });
export type WebScanStopResult = z.infer<typeof WebScanStopResultSchema>;

/** GET /api/admin/web-scan/scans/:scanId/export — query. The reply is not JSON. */
export const WebScanExportQuerySchema = z.strictObject({
  format: z.enum(['html', 'json']),
});

/** The bounded safe progress event streamed to the scan page (ADR-0021 shape). */
export const WebScanEventDtoSchema = z.strictObject({
  scanId: z.string(),
  siteId: z.string(),
  kind: z.enum(['progress', 'queued', 'running', 'completed', 'stopped', 'failed']),
  status: WebScanScanStatusSchema,
  requests: z.number(),
  pages: z.number(),
  elapsedMs: z.number(),
});
export type WebScanEventDto = z.infer<typeof WebScanEventDtoSchema>;

/** POST /api/admin/web-scan/sites/:siteId/exceptions — a resolution of an occurrence. */
export const WebScanCreateExceptionSchema = z.strictObject({
  occurrenceKey: WebScanDigestSchema,
  evidenceHash: WebScanDigestSchema,
  kind: z.enum(['accepted', 'false_positive']),
  reasonCategory: z.enum([
    'not_applicable',
    'already_mitigated',
    'accepted_risk',
    'out_of_scope',
    'third_party_dependency',
    'test_environment',
  ]),
  reason: z.string().max(2000),
  expiresAt: WebScanIsoTimestampSchema.nullable().optional(),
});
export type WebScanCreateExceptionRequest = z.infer<typeof WebScanCreateExceptionSchema>;

/** GET/POST .../exceptions and DELETE .../exceptions/:exceptionId. */
export const WebScanExceptionDtoSchema = z.strictObject({
  id: z.string(),
  siteId: z.string(),
  occurrenceKey: z.string(),
  evidenceHash: z.string(),
  kind: z.enum(['accepted', 'false_positive']),
  reasonCategory: z.enum([
    'not_applicable',
    'already_mitigated',
    'accepted_risk',
    'out_of_scope',
    'third_party_dependency',
    'test_environment',
  ]),
  reason: z.string(),
  expiresAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
});
export type WebScanExceptionDto = z.infer<typeof WebScanExceptionDtoSchema>;

/** GET /api/admin/web-scan/sites/:siteId/exceptions — every resolution, incl. revoked ones. */
export const WebScanExceptionsPageSchema = z.strictObject({
  exceptions: z.array(WebScanExceptionDtoSchema),
});
export type WebScanExceptionsPage = z.infer<typeof WebScanExceptionsPageSchema>;

/** GET /api/admin/web-scan/audit — an offset page of the immutable history. */
export const WebScanAuditEntrySchema = z.strictObject({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  createdAt: z.string(),
});
export type WebScanAuditEntryDto = z.infer<typeof WebScanAuditEntrySchema>;

/**
 * The offset page the sites and audit routes accept.
 *
 * Bad values are answered 422 instead of being corrected silently, so a wrong
 * page never shows the administrator a different slice than the one asked for.
 * The bounds mirror `ADMIN_MAX_PAGE_SIZE` / `ADMIN_DEFAULT_PAGE_SIZE` (`admin/queries.ts`).
 */
export const WebScanPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type WebScanPageQuery = z.infer<typeof WebScanPageQuerySchema>;

/**
 * GET /api/admin/web-scan/audit — an offset page of the immutable history.
 *
 * The page carries the total number of rows of the log, so the dashboard can
 * show how many pages there are without asking for them one by one.
 */
export const WebScanAuditPageSchema = z.strictObject({
  audit: z.array(WebScanAuditEntrySchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type WebScanAuditPage = z.infer<typeof WebScanAuditPageSchema>;

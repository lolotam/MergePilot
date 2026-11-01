import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CheckSwitches, CoverageEntry, ScanScope } from '@mergepilot/webscan';
import type {
  WebScanAlertEpisode,
  WebScanApprovedInstallation,
  WebScanSchedule,
} from '../webscan/types.js';

/**
 * The website security scan tables (ADR-0052).
 *
 * They mirror `apps/app/migrations/0019_web_scan.sql`. None of them is
 * workspace-owned: there is no workspace id and no foreign key to the
 * organization table, so a workspace user route can never reach them.
 *
 * The settings table holds exactly one row. The fixed id and its check
 * constraint make a second row impossible.
 */

export const WEB_SCAN_SETTINGS_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';

export const webScanSettings = pgTable('web_scan_settings', {
  id: uuid('id').primaryKey().default(sql`${WEB_SCAN_SETTINGS_ID}::uuid`),
  paused: boolean('paused').notNull().default(true),
  alertsEnabled: boolean('alerts_enabled').notNull().default(false),
  maxRequests: integer('max_requests').notNull().default(500),
  maxPages: integer('max_pages').notNull().default(100),
  maxActiveLinks: integer('max_active_links').notNull().default(30),
  requestsPerSecond: integer('requests_per_second').notNull().default(2),
  requestTimeoutMs: integer('request_timeout_ms').notNull().default(10_000),
  maxResponseBytes: integer('max_response_bytes').notNull().default(1_048_576),
  totalTimeoutMs: integer('total_timeout_ms').notNull().default(1_200_000),
  retentionDays: integer('retention_days').notNull().default(365),
  contact: text('contact').notNull().default(''),
  alertMinSeverity: text('alert_min_severity').notNull().default('high'),
  alertMinValidation: text('alert_min_validation').notNull().default('Likely'),
  checks: jsonb('checks')
    .$type<CheckSwitches>()
    .notNull()
    .default(
      sql`'{"headers":true,"cookies":true,"transport":true,"disclosure":true,"files":true,"active":false}'::jsonb`,
    ),
  defaultSchedule: jsonb('default_schedule')
    .$type<WebScanSchedule>()
    .notNull()
    .default(sql`'{"frequency":"weekly","weekday":5,"hour":4,"minute":0,"enabled":false}'::jsonb`),
  approvedInstallations: jsonb('approved_installations')
    .$type<WebScanApprovedInstallation[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export const webScanSites = pgTable(
  'web_scan_sites',
  {
    id: uuid('id').primaryKey(),
    hostname: text('hostname').notNull(),
    baseUrl: text('base_url').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    repositoryOwner: text('repository_owner'),
    repositoryName: text('repository_name'),
    repositoryId: bigint('repository_id', { mode: 'number' }),
    installationId: bigint('installation_id', { mode: 'number' }),
    githubAccountId: bigint('github_account_id', { mode: 'number' }),
    /** The site identity key, sealed with the purpose-scoped vault. */
    identityKeyCiphertext: text('identity_key_ciphertext').notNull(),
    identityKeyVersion: integer('identity_key_version').notNull(),
    overrides: jsonb('overrides').$type<ScanScope>().notNull().default(sql`'{}'::jsonb`),
    schedule: jsonb('schedule').$type<WebScanSchedule | null>(),
    authorizationAuditId: uuid('authorization_audit_id'),
    authorizedBy: text('authorized_by'),
    authorizedAt: timestamp('authorized_at', { withTimezone: true, mode: 'date' }),
    scopeVersion: integer('scope_version').notNull().default(1),
    alertEpisodes: jsonb('alert_episodes')
      .$type<WebScanAlertEpisode[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The coverage of the last completed scan. It lives on the site row so the current
     * coverage of a site survives the expiry of the snapshot it was produced by.
     */
    lastCoverageSummary: jsonb('last_coverage_summary').$type<CoverageEntry[]>(),
    lastCoverageScanId: uuid('last_coverage_scan_id'),
    lastCoverageAt: timestamp('last_coverage_at', { withTimezone: true, mode: 'date' }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    lastScanAt: timestamp('last_scan_at', { withTimezone: true, mode: 'date' }),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_web_scan_sites_hostname').on(sql`lower(${table.hostname})`),
    index('idx_web_scan_sites_next_run').on(table.nextRunAt),
  ],
);

export const webScans = pgTable(
  'web_scans',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    siteId: uuid('site_id')
      .notNull()
      .references(() => webScanSites.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('queued'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
    idempotencyKey: text('idempotency_key'),
    requestFingerprint: text('request_fingerprint'),
    outboxState: text('outbox_state').notNull().default('pending'),
    outboxPublishedAt: timestamp('outbox_published_at', { withTimezone: true, mode: 'date' }),
    attemptId: text('attempt_id'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' }),
    stopReason: text('stop_reason'),
    failReason: text('fail_reason'),
    requests: integer('requests').notNull().default(0),
    pages: integer('pages').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    effectiveSettings: jsonb('effective_settings').$type<unknown>().notNull(),
    coverageSummary: jsonb('coverage_summary').$type<CoverageEntry[] | null>(),
    authorizationAuditId: uuid('authorization_audit_id'),
    scopeVersion: integer('scope_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_web_scans_site_scheduled_for')
      .on(table.siteId, table.scheduledFor)
      .where(sql`${table.trigger} = 'scheduled'`),
    uniqueIndex('idx_web_scans_site_manual_idempotency')
      .on(table.siteId, table.idempotencyKey)
      .where(sql`${table.trigger} = 'manual'`),
    index('idx_web_scans_site_created').on(table.siteId, table.createdAt),
  ],
);

export const webScanFindings = pgTable(
  'web_scan_findings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => webScans.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => webScanSites.id, { onDelete: 'cascade' }),
    issueKey: text('issue_key').notNull(),
    occurrenceKey: text('occurrence_key').notNull(),
    targetKey: text('target_key').notNull(),
    checkId: text('check_id').notNull(),
    checkVersion: integer('check_version').notNull(),
    issueId: text('issue_id').notNull(),
    subject: text('subject').notNull(),
    severity: text('severity').notNull(),
    validation: text('validation').notNull(),
    confidence: text('confidence').notNull(),
    riskScore: numeric('risk_score', { precision: 6, scale: 3 }),
    riskFactors: jsonb('risk_factors').$type<unknown>(),
    safeLocation: text('safe_location').notNull(),
    evidence: jsonb('evidence').$type<unknown>(),
    evidenceHash: text('evidence_hash').notNull(),
    comparison: text('comparison').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_web_scan_findings_scan_occurrence').on(table.scanId, table.occurrenceKey),
  ],
);

export const webScanExceptions = pgTable(
  'web_scan_exceptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    siteId: uuid('site_id')
      .notNull()
      .references(() => webScanSites.id, { onDelete: 'cascade' }),
    occurrenceKey: text('occurrence_key').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    kind: text('kind').notNull(),
    reasonCategory: text('reason_category').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: text('revoked_by'),
  },
  (table) => [index('idx_web_scan_exceptions_site_occurrence').on(table.siteId, table.occurrenceKey)],
);

export const webScanOccurrences = pgTable(
  'web_scan_occurrences',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    siteId: uuid('site_id')
      .notNull()
      .references(() => webScanSites.id, { onDelete: 'cascade' }),
    occurrenceKey: text('occurrence_key').notNull(),
    targetKey: text('target_key').notNull(),
    issueKey: text('issue_key').notNull(),
    checkId: text('check_id').notNull(),
    checkVersion: integer('check_version').notNull(),
    issueId: text('issue_id').notNull(),
    subject: text('subject').notNull(),
    severity: text('severity').notNull(),
    validation: text('validation').notNull(),
    confidence: text('confidence').notNull(),
    safeLocation: text('safe_location').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    evidence: jsonb('evidence').$type<unknown>(),
    state: text('state').notNull(),
    archiveReason: text('archive_reason'),
    comparison: text('comparison'),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastCompletedScanId: uuid('last_completed_scan_id').references(() => webScans.id, {
      onDelete: 'set null',
    }),
    exceptionId: uuid('exception_id').references(() => webScanExceptions.id, {
      onDelete: 'set null',
    }),
    notificationEpisodeRef: text('notification_episode_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('web_scan_occurrences_unique_site_occurrence').on(table.siteId, table.occurrenceKey),
    index('idx_web_scan_occurrences_site_state').on(table.siteId, table.state),
    index('idx_web_scan_occurrences_last_observed').on(table.siteId, table.lastObservedAt),
  ],
);

export const webScanAlerts = pgTable(
  'web_scan_alerts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    siteId: uuid('site_id')
      .notNull()
      .references(() => webScanSites.id, { onDelete: 'cascade' }),
    issueKey: text('issue_key').notNull(),
    episodeKey: text('episode_key').notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    githubAccountId: bigint('github_account_id', { mode: 'number' }).notNull(),
    issueNumber: integer('issue_number'),
    deliveryMarker: text('delivery_marker').notNull(),
    deliveryState: text('delivery_state').notNull().default('pending'),
    issueState: text('issue_state').notNull().default('unknown'),
    occurrenceKeys: jsonb('occurrence_keys').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('web_scan_alerts_marker_unique').on(table.deliveryMarker),
    index('idx_web_scan_alerts_site_issue').on(table.siteId, table.issueKey),
  ],
);

export const webScanAudit = pgTable(
  'web_scan_audit',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_web_scan_audit_created_at').on(table.createdAt),
    index('idx_web_scan_audit_target').on(table.targetType, table.targetId),
  ],
);

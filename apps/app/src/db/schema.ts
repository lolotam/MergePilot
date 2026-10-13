import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const webhookDeliveries = pgTable('webhook_deliveries', {
  deliveryId: text('delivery_id').primaryKey(),
  event: text('event').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const installations = pgTable(
  'installations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    workspaceId: text('workspace_id'),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(),
    repositorySelection: text('repository_selection').notNull(),
    suspended: boolean('suspended').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_installations_workspace_id').on(table.workspaceId),
  ],
);

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: text('workspace_id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  language: text('language').notNull(),
  monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 12, scale: 4 }),
  effort: text('effort'),
  heavyProvider: text('heavy_provider'),
  heavyModel: text('heavy_model'),
  heavyEffort: text('heavy_effort'),
  heavyThresholdLines: integer('heavy_threshold_lines').default(800),
  fallback: jsonb('fallback').notNull().default(sql`'[]'::jsonb`),
  minSeverity: text('min_severity').notNull().default('medium'),
  /** Migration 0006: days to keep review runs; NULL = forever. */
  runRetentionDays: integer('run_retention_days').default(30),
  /** Migration 0006: `owner/repo` -> palette key. */
  repoColors: jsonb('repo_colors').notNull().default(sql`'{}'::jsonb`),
  /** Migration 0007: the Jev judge (ADR-0015). */
  judgeEnabled: boolean('judge_enabled').notNull().default(false),
  judgeProvider: text('judge_provider'),
  judgeModel: text('judge_model'),
  /** Not read since migration 0010 (kept one release for rollback; written as the closest old mode). */
  judgeMode: text('judge_mode').notNull().default('off'),
  judgeThreshold: numeric('judge_threshold', { precision: 4, scale: 3 }).notNull().default('0.35'),
  judgeFallback: jsonb('judge_fallback').notNull().default(sql`'[]'::jsonb`),
  /** Migration 0010: the judge's uses (ADR-0015 multi-use). */
  judgeUses: text('judge_uses').array().notNull().default(sql`'{}'::text[]`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    last4: text('last4').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    baseUrl: text('base_url'),
  },
  (table) => [
    uniqueIndex('provider_credentials_workspace_provider_unique').on(
      table.workspaceId,
      table.provider,
    ),
    index('idx_provider_credentials_workspace_id').on(table.workspaceId),
  ],
);

export const reviewRuns = pgTable(
  'review_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    jobId: text('job_id'),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    repoFullName: text('repo_full_name').notNull(),
    pullNumber: integer('pull_number').notNull(),
    headSha: text('head_sha').notNull(),
    status: text('status').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    /** Heartbeat: the stale-run sweep fails queued/running runs whose heartbeat is too old. */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    provider: text('provider'),
    model: text('model'),
    effort: text('effort'),
    fallbackFrom: text('fallback_from'),
    findingsCount: integer('findings_count'),
    result: jsonb('result'),
    reviewUrl: text('review_url'),
  },
  (table) => [
    index('idx_review_runs_workspace_id').on(table.workspaceId),
    index('idx_review_runs_workspace_created_at_desc').on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
    uniqueIndex('idx_review_runs_workspace_job_id_active')
      .on(table.workspaceId, table.jobId)
      .where(sql`job_id IS NOT NULL AND status IN ('queued', 'running', 'failed')`),
    index('idx_review_runs_active_updated_at')
      .on(table.updatedAt)
      .where(sql`status IN ('queued', 'running')`),
    index('idx_review_runs_workspace_repo').on(table.workspaceId, table.repoFullName),
    // Migration 0004: one queued/running run per workspace, repo, PR and head commit.
    uniqueIndex('idx_review_runs_active_pr_head')
      .on(table.workspaceId, table.repoFullName, table.pullNumber, table.headSha)
      .where(sql`status IN ('queued', 'running')`),
  ],
);

/** Migration 0006: per workspace and UTC month; finished runs are added, deletions never subtract. */
export const workspaceUsageMonthly = pgTable(
  'workspace_usage_monthly',
  {
    workspaceId: text('workspace_id').notNull(),
    /** First day of the UTC month the run was created in, `YYYY-MM-01`. */
    month: date('month', { mode: 'string' }).notNull(),
    runsTotal: integer('runs_total').notNull().default(0),
    runsCompleted: integer('runs_completed').notNull().default(0),
    runsFailed: integer('runs_failed').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.month] })],
);

/** Migration 0006: maintenance job log; an unfinished row per kind is the job's lease. */
export const maintenanceRuns = pgTable(
  'maintenance_runs',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    deletedCount: integer('deleted_count').notNull().default(0),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('idx_maintenance_runs_one_active')
      .on(table.kind)
      .where(sql`finished_at IS NULL`),
    index('idx_maintenance_runs_kind_started_at').on(table.kind, table.startedAt.desc()),
  ],
);

export const schemaMigrations = pgTable('schema_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

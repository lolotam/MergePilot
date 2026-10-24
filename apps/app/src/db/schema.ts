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
  smallint,
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
  /** Migration 0015: per-bot API spending limit, $0.50?$1000 (ADR-0036). */
  perReviewUsd: numeric('per_review_usd', { precision: 10, scale: 2 }).notNull().default('0.50'),
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
  /** Migration 0008: manual model prices (ADR-0016), at most 50. */
  priceOverrides: jsonb('price_overrides').notNull().default(sql`'[]'::jsonb`),
  /** Migration 0009: the reviewer panel's main bot and output mode (ADR-0017). */
  botName: text('bot_name').notNull().default('MergePilot'),
  botLogo: text('bot_logo').notNull().default('pilot'),
  panelMode: text('panel_mode').notNull().default('separate'),
  panelMinAgreement: smallint('panel_min_agreement').notNull().default(1),
  /** Migration 0010: the judge's uses (ADR-0015 multi-use). */
  judgeUses: text('judge_uses').array().notNull().default(sql`'{}'::text[]`),
  /** Migration 0013: findings per published review, 5-50 in steps of 5 (ADR-0033). */
  maxFindings: smallint('max_findings').notNull().default(5),
  /** Migration 0014: the main bot's review skill (ADR-0034); null = Default. */
  skillId: uuid('skill_id'),
  /** Migration 0014: the name of the bot's skill that was deleted, shown until a skill is chosen again. */
  skillRemovedName: text('skill_removed_name'),
  exploreEnabled: boolean('explore_enabled').notNull().default(false),
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
    /** Migration 0016: a refused subscription refresh; a new sign-in clears it (ADR-0037). */
    signInRequiredAt: timestamp('sign_in_required_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('provider_credentials_workspace_provider_unique').on(
      table.workspaceId,
      table.provider,
    ),
    index('idx_provider_credentials_workspace_id').on(table.workspaceId),
  ],
);

/** Migration 0011: ordered API keys for gemini, openrouter and opencode-zen (ADR-0026). */
export const providerApiKeys = pgTable(
  'provider_api_keys',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    position: integer('position').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    last4: text('last4').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastTestStatus: text('last_test_status'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('provider_api_keys_workspace_provider_position').on(
      table.workspaceId,
      table.provider,
      table.position,
    ),
    index('idx_provider_api_keys_workspace_provider').on(
      table.workspaceId,
      table.provider,
      table.position,
    ),
  ],
);

/** Migration 0011: last successful key index, shared by the web and worker processes. */
export const providerKeyCursors = pgTable(
  'provider_key_cursors',
  {
    workspaceId: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    position: integer('position').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.provider] })],
);

/** Migration 0012: default auth method for dual-method providers (ADR-0027). */
export const providerAuthPreferences = pgTable(
  'provider_auth_preferences',
  {
    workspaceId: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    defaultMethod: text('default_method').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.provider] })],
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
    /** Migration 0009: the reviewer-panel bot (1 = main) and its name when the run was created. */
    botSlot: smallint('bot_slot').notNull().default(1),
    botName: text('bot_name'),
    /** Migration 0014: the review skill's name when the run was created (ADR-0034). */
    skillName: text('skill_name'),
  },
  (table) => [
    index('idx_review_runs_workspace_id').on(table.workspaceId),
    index('idx_review_runs_workspace_created_at_desc').on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
    // Migrations 0003 and 0009: one reusable run per job and bot slot.
    uniqueIndex('idx_review_runs_workspace_job_id_active')
      .on(table.workspaceId, table.jobId, table.botSlot)
      .where(sql`job_id IS NOT NULL AND status IN ('queued', 'running', 'failed')`),
    index('idx_review_runs_active_updated_at')
      .on(table.updatedAt)
      .where(sql`status IN ('queued', 'running')`),
    index('idx_review_runs_workspace_repo').on(table.workspaceId, table.repoFullName),
    // Migrations 0004 and 0009: one queued/running run per workspace, repo, PR, head commit and bot.
    uniqueIndex('idx_review_runs_active_pr_head')
      .on(table.workspaceId, table.repoFullName, table.pullNumber, table.headSha, table.botSlot)
      .where(sql`status IN ('queued', 'running')`),
  ],
);

/**
 * Migration 0009: the reviewer panel's extra bots, slots 2-5 (ADR-0017). `workspace_id` references
 * the Better Auth organization with ON DELETE CASCADE (declared in the SQL migration only).
 */
export const reviewerBots = pgTable(
  'reviewer_bots',
  {
    workspaceId: text('workspace_id').notNull(),
    slot: smallint('slot').notNull(),
    name: text('name').notNull(),
    logo: text('logo').notNull(),
    active: boolean('active').notNull().default(true),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    effort: text('effort'),
    fallback: jsonb('fallback').notNull().default(sql`'[]'::jsonb`),
    /** Migration 0014: the bot's review skill (ADR-0034); null = Default. */
    skillId: uuid('skill_id'),
    skillRemovedName: text('skill_removed_name'),
    exploreEnabled: boolean('explore_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.slot] }),
    uniqueIndex('idx_reviewer_bots_workspace_name').on(table.workspaceId, sql`lower(${table.name})`),
  ],
);

/**
 * Migration 0014: review skills (ADR-0034). `workspace_id` references the organization with ON
 * DELETE CASCADE, and the bots' composite foreign keys use ON DELETE SET NULL (skill_id); both are
 * declared in the SQL migration only.
 */
export const reviewSkills = pgTable(
  'review_skills',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeTokens: integer('size_tokens').notNull(),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('review_skills_workspace_id_id_key').on(table.workspaceId, table.id),
    uniqueIndex('idx_review_skills_workspace_name').on(table.workspaceId, sql`lower(${table.name})`),
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

/** Migration 0008: model prices from the public catalogs (ADR-0016), USD per million tokens. */
export const modelPrices = pgTable(
  'model_prices',
  {
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputPerMTok: numeric('input_per_mtok', { precision: 12, scale: 6 }).notNull(),
    outputPerMTok: numeric('output_per_mtok', { precision: 12, scale: 6 }).notNull(),
    cacheReadPerMTok: numeric('cache_read_per_mtok', { precision: 12, scale: 6 }),
    cacheWritePerMTok: numeric('cache_write_per_mtok', { precision: 12, scale: 6 }),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.model] }),
    index('idx_model_prices_lower').on(sql`lower(${table.provider})`, sql`lower(${table.model})`),
    index('idx_model_prices_source_fetched_at').on(table.source, table.fetchedAt.desc()),
  ],
);

export const schemaMigrations = pgTable('schema_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

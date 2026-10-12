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
  ],
);

export const schemaMigrations = pgTable('schema_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { InstallationAlreadyLinkedError } from '../core/types.js';
import { deleteWorkspaceInTx, withLiveWorkspace } from './workspace-lock.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type {
  ApiProvider,
  AppStore,
  FinishReviewRunOptions,
  Installation,
  ListReviewRunsOptions,
  ListReviewRunsResult,
  ReviewRun,
  StoredCredential,
  WorkspaceSettings,
} from '../core/types.js';
import {
  createPgReviewRun,
  failPgStaleRuns,
  finishPgReviewRun,
  mapReviewRunRow,
  queryPgReviewRuns,
} from './pg-runs.js';
import { installations, providerCredentials, reviewRuns, webhookDeliveries, workspaceSettings } from './schema.js';
import type * as schema from './schema.js';

export type AppDb = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export class PgStore implements AppStore {
  constructor(private readonly db: AppDb) {}

  async recordDelivery(deliveryId: string, event: string): Promise<boolean> {
    const result = await this.db
      .insert(webhookDeliveries)
      .values({ deliveryId, event })
      .onConflictDoNothing()
      .returning();
    return result.length > 0;
  }

  async upsertInstallation(installation: Installation): Promise<void> {
    await this.db
      .insert(installations)
      .values({
        id: installation.id,
        workspaceId: installation.workspaceId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        suspended: installation.suspended,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: installations.id,
        set: {
          workspaceId: installation.workspaceId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositorySelection: installation.repositorySelection,
          suspended: installation.suspended,
          updatedAt: new Date(),
        },
      });
  }

  async upsertPendingInstallation(
    installation: Omit<Installation, 'workspaceId'>,
  ): Promise<void> {
    await this.db
      .insert(installations)
      .values({
        id: installation.id,
        workspaceId: null,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        suspended: installation.suspended,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: installations.id,
        set: {
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositorySelection: installation.repositorySelection,
          suspended: installation.suspended,
          updatedAt: new Date(),
        },
      });
  }

  async linkInstallation(installationId: number, workspaceId: string): Promise<void> {
    // Atomic: only claim an installation that is unlinked or already ours, so two workspaces
    // linking the same pending installation at once cannot both succeed.
    const result = await withLiveWorkspace(this.db, workspaceId, async (tx) =>
      await tx
        .update(installations)
        .set({ workspaceId, updatedAt: new Date() })
        .where(
          and(
            eq(installations.id, installationId),
            sql`(${installations.workspaceId} IS NULL OR ${installations.workspaceId} = ${workspaceId})`,
          ),
        )
        .returning(),
    );
    if (result.length > 0) return;
    const exists = await this.db.select({ id: installations.id }).from(installations).where(eq(installations.id, installationId));
    throw exists.length > 0
      ? new InstallationAlreadyLinkedError(installationId)
      : new Error(`installation ${installationId} not found`);
  }

  async getInstallation(installationId: number): Promise<Installation | null> {
    const rows = await this.db
      .select()
      .from(installations)
      .where(eq(installations.id, installationId));
    const row = rows[0];
    if (!row || !row.workspaceId) {
      return null;
    }
    return {
      id: Number(row.id),
      workspaceId: row.workspaceId,
      accountLogin: row.accountLogin,
      accountType: row.accountType as 'User' | 'Organization',
      repositorySelection: row.repositorySelection as 'all' | 'selected',
      suspended: Boolean(row.suspended),
    };
  }

  async listInstallations(workspaceId: string): Promise<Installation[]> {
    const rows = await this.db
      .select()
      .from(installations)
      .where(eq(installations.workspaceId, workspaceId));
    return rows.map((row) => ({
      id: Number(row.id),
      workspaceId: row.workspaceId as string,
      accountLogin: row.accountLogin,
      accountType: row.accountType as 'User' | 'Organization',
      repositorySelection: row.repositorySelection as 'all' | 'selected',
      suspended: Boolean(row.suspended),
    }));
  }

  async deleteInstallation(installationId: number): Promise<void> {
    await this.db
      .delete(installations)
      .where(eq(installations.id, installationId));
  }

  async setInstallationSuspended(
    installationId: number,
    suspended: boolean,
  ): Promise<void> {
    await this.db
      .update(installations)
      .set({ suspended, updatedAt: new Date() })
      .where(eq(installations.id, installationId));
  }

  async getSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
    const rows = await this.db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      workspaceId: row.workspaceId,
      provider: row.provider as ApiProvider,
      model: row.model,
      language: row.language as 'ar' | 'en',
      monthlyBudgetUsd:
        row.monthlyBudgetUsd !== null ? Number(row.monthlyBudgetUsd) : null,
    };
  }

  async saveSettings(settings: WorkspaceSettings): Promise<void> {
    const budgetStr =
      settings.monthlyBudgetUsd !== null ? String(settings.monthlyBudgetUsd) : null;
    const values = {
      provider: settings.provider,
      model: settings.model,
      language: settings.language,
      monthlyBudgetUsd: budgetStr,
      updatedAt: new Date(),
    };
    await withLiveWorkspace(this.db, settings.workspaceId, async (tx) => {
      await tx
        .insert(workspaceSettings)
        .values({ workspaceId: settings.workspaceId, ...values })
        .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: values });
    });
  }

  async saveCredential(credential: StoredCredential): Promise<void> {
    const values = {
      id: credential.id,
      ciphertext: credential.ciphertext,
      keyVersion: credential.keyVersion,
      last4: credential.last4,
      createdBy: credential.createdBy,
      createdAt: credential.createdAt,
    };
    await withLiveWorkspace(this.db, credential.workspaceId, async (tx) => {
      await tx
        .insert(providerCredentials)
        .values({ workspaceId: credential.workspaceId, provider: credential.provider, ...values })
        .onConflictDoUpdate({
          target: [providerCredentials.workspaceId, providerCredentials.provider],
          set: values,
        });
    });
  }

  async getCredential(
    workspaceId: string,
    provider: ApiProvider,
  ): Promise<StoredCredential | null> {
    const rows = await this.db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.workspaceId, workspaceId),
          eq(providerCredentials.provider, provider),
        ),
      );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider as ApiProvider,
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
      last4: row.last4,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt),
    };
  }

  async listCredentials(
    workspaceId: string,
  ): Promise<Array<Omit<StoredCredential, 'ciphertext'>>> {
    const rows = await this.db
      .select({
        id: providerCredentials.id,
        workspaceId: providerCredentials.workspaceId,
        provider: providerCredentials.provider,
        keyVersion: providerCredentials.keyVersion,
        last4: providerCredentials.last4,
        createdBy: providerCredentials.createdBy,
        createdAt: providerCredentials.createdAt,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.workspaceId, workspaceId));
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider as ApiProvider,
      keyVersion: row.keyVersion,
      last4: row.last4,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt),
    }));
  }

  async deleteCredential(workspaceId: string, provider: ApiProvider): Promise<void> {
    await this.db
      .delete(providerCredentials)
      .where(
        and(
          eq(providerCredentials.workspaceId, workspaceId),
          eq(providerCredentials.provider, provider),
        ),
      );
  }

  async createReviewRun(
    run: Omit<ReviewRun, 'id' | 'createdAt' | 'finishedAt'>,
  ): Promise<ReviewRun> {
    return createPgReviewRun(this.db, run);
  }

  async finishReviewRun(
    workspaceId: string,
    id: string,
    result: FinishReviewRunOptions,
  ): Promise<void> {
    return finishPgReviewRun(this.db, workspaceId, id, result);
  }

  async getReviewRun(workspaceId: string, id: string): Promise<ReviewRun | null> {
    const rows = await this.db
      .select()
      .from(reviewRuns)
      .where(and(eq(reviewRuns.id, id), eq(reviewRuns.workspaceId, workspaceId)));
    const row = rows[0];
    return row ? mapReviewRunRow(row) : null;
  }

  async listReviewRunRepos(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ repo: reviewRuns.repoFullName })
      .from(reviewRuns)
      .where(eq(reviewRuns.workspaceId, workspaceId))
      .orderBy(asc(reviewRuns.repoFullName));
    return rows.map((r) => r.repo);
  }

  async failStaleRuns(olderThan: Date): Promise<number> {
    return failPgStaleRuns(this.db, olderThan);
  }

  async listReviewRuns(workspaceId: string, limit: number): Promise<ReviewRun[]>;
  async listReviewRuns(
    workspaceId: string,
    options: ListReviewRunsOptions,
  ): Promise<ListReviewRunsResult>;
  async listReviewRuns(
    workspaceId: string,
    limitOrOptions?: number | ListReviewRunsOptions,
  ): Promise<ReviewRun[] | ListReviewRunsResult> {
    return queryPgReviewRuns(this.db, workspaceId, limitOrOptions);
  }

  async monthCostUsd(workspaceId: string, monthStart: Date): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${reviewRuns.costUsd}), 0)`,
      })
      .from(reviewRuns)
      .where(
        and(
          eq(reviewRuns.workspaceId, workspaceId),
          gte(reviewRuns.createdAt, monthStart),
        ),
      );
    const total = rows[0]?.total ?? '0';
    return Number(total);
  }

  async deleteWorkspace(workspaceId: string): Promise<{ organizationDeleted: boolean }> {
    // Organization row first, then the workspace data, in one transaction (see deleteWorkspaceInTx).
    await this.db.transaction((tx) => deleteWorkspaceInTx(tx, workspaceId));
    return { organizationDeleted: true };
  }
}

import { and, asc, eq, sql } from 'drizzle-orm';
import { InstallationAlreadyLinkedError } from '../core/types.js';
import { deleteWorkspaceInTx, withLiveWorkspace } from './workspace-lock.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type {
  ApiProvider,
  AppStore,
  DeleteRunsTarget,
  FinishReviewRunOptions,
  Installation,
  LatestFailedRunsOptions,
  ListReviewRunGroupsResult,
  ListReviewRunsOptions,
  ListReviewRunsResult,
  MaintenanceKind,
  MaintenanceRun,
  MonthlyUsage,
  NewReviewRun,
  RetentionPolicy,
  ReviewRun,
  StoredCredential,
  WorkspaceSettings,
} from '../core/types.js';
import {
  deletePgReviewRuns,
  finishPgMaintenanceRun,
  getLatestPgMaintenanceRun,
  listPgRetentionPolicies,
  prunePgReviewRuns,
  startPgMaintenanceRun,
} from './pg-maintenance.js';
import { listPgRunGroups } from './pg-run-groups.js';
import {
  createPgReviewRun,
  findPgActiveReviewRun,
  listPgLatestFailedRuns,
  mapReviewRunRow,
  queryPgReviewRuns,
  touchPgReviewRun,
} from './pg-runs.js';
import { getPgSettings, savePgSettings } from './pg-settings.js';
import { failPgStaleRuns, finishPgReviewRun, listPgMonthlyUsage, monthPgCostUsd } from './pg-usage.js';
import { installations, providerCredentials, reviewRuns, webhookDeliveries } from './schema.js';
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
    return getPgSettings(this.db, workspaceId);
  }

  async saveSettings(settings: WorkspaceSettings): Promise<void> {
    return savePgSettings(this.db, settings);
  }

  async saveCredential(credential: StoredCredential): Promise<void> {
    const values = {
      id: credential.id,
      ciphertext: credential.ciphertext,
      keyVersion: credential.keyVersion,
      last4: credential.last4,
      createdBy: credential.createdBy,
      createdAt: credential.createdAt,
      baseUrl: credential.baseUrl ?? null,
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

  async getCredential(workspaceId: string, provider: ApiProvider): Promise<StoredCredential | null> {
    const rows = await this.db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.workspaceId, workspaceId), eq(providerCredentials.provider, provider)));
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider as ApiProvider,
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
      last4: row.last4,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt),
      baseUrl: row.baseUrl ?? null,
    };
  }

  async listCredentials(workspaceId: string): Promise<Array<Omit<StoredCredential, 'ciphertext'>>> {
    const rows = await this.db
      .select({
        id: providerCredentials.id,
        workspaceId: providerCredentials.workspaceId,
        provider: providerCredentials.provider,
        keyVersion: providerCredentials.keyVersion,
        last4: providerCredentials.last4,
        createdBy: providerCredentials.createdBy,
        createdAt: providerCredentials.createdAt,
        baseUrl: providerCredentials.baseUrl,
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
      baseUrl: row.baseUrl ?? null,
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

  async createReviewRun(run: NewReviewRun): Promise<ReviewRun> {
    return createPgReviewRun(this.db, run);
  }

  async touchReviewRun(workspaceId: string, id: string): Promise<void> {
    return touchPgReviewRun(this.db, workspaceId, id);
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

  async findActiveReviewRun(
    workspaceId: string,
    repoFullName: string,
    pullNumber: number,
    headSha: string,
  ): Promise<ReviewRun | null> {
    return findPgActiveReviewRun(this.db, workspaceId, repoFullName, pullNumber, headSha);
  }

  async listLatestFailedRuns(
    workspaceId: string,
    options?: LatestFailedRunsOptions,
  ): Promise<ReviewRun[]> {
    return listPgLatestFailedRuns(this.db, workspaceId, options);
  }

  async failStaleRuns(heartbeatBefore: Date): Promise<number> {
    return failPgStaleRuns(this.db, heartbeatBefore);
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
    return monthPgCostUsd(this.db, workspaceId, monthStart);
  }

  async listMonthlyUsage(workspaceId: string): Promise<MonthlyUsage[]> {
    return listPgMonthlyUsage(this.db, workspaceId);
  }

  async listReviewRunGroups(workspaceId: string, options: ListReviewRunsOptions): Promise<ListReviewRunGroupsResult> {
    return listPgRunGroups(this.db, workspaceId, options);
  }

  async deleteReviewRuns(workspaceId: string, target: DeleteRunsTarget): Promise<number> {
    return deletePgReviewRuns(this.db, workspaceId, target);
  }

  async listRetentionPolicies(): Promise<RetentionPolicy[]> {
    return listPgRetentionPolicies(this.db);
  }

  async pruneReviewRuns(workspaceId: string, createdBefore: Date, limit: number): Promise<number> {
    return prunePgReviewRuns(this.db, workspaceId, createdBefore, limit);
  }

  async startMaintenanceRun(kind: MaintenanceKind, staleBefore: Date): Promise<MaintenanceRun | null> {
    return startPgMaintenanceRun(this.db, kind, staleBefore);
  }

  async finishMaintenanceRun(id: string, result: { deletedCount: number; error: string | null }): Promise<void> {
    return finishPgMaintenanceRun(this.db, id, result);
  }

  async getLatestMaintenanceRun(kind: MaintenanceKind): Promise<MaintenanceRun | null> {
    return getLatestPgMaintenanceRun(this.db, kind);
  }

  async deleteWorkspace(workspaceId: string): Promise<{ organizationDeleted: boolean }> {
    // Organization row first, then the workspace data, in one transaction (see deleteWorkspaceInTx).
    await this.db.transaction((tx) => deleteWorkspaceInTx(tx, workspaceId));
    return { organizationDeleted: true };
  }
}

import { and, asc, eq, sql } from 'drizzle-orm';
import { InstallationAlreadyLinkedError, type SaveSettingsOptions } from '../core/types.js';
import { deleteWorkspaceInTx, lockCredential, withLiveWorkspace } from './workspace-lock.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type {
  KeyProvider, AppStore, DeleteRunsTarget, FinishReviewRunOptions, Installation, LatestFailedRunsOptions,
  KeyQuotaStatus, ListReviewRunGroupsResult, ListReviewRunsOptions, ListReviewRunsResult, MaintenanceKind, MaintenanceRun,
  MonthlyUsage, NewReviewRun, ProviderAuthMethod, ProviderKeyChange, RetentionPolicy, ReviewRun, ReviewerBot, StoredCredential,
  StoredProviderKey, WorkspaceRestore,
  WorkspaceSettings, ModelKey,
  StaleRunRef,
  StoredModelPrice, DeletedReviewSkill, NewReviewSkill, ReviewSkillChange, ReviewSkillRecord, ReviewSkillSummary,
} from '../core/types.js';
import type { PriceEntry, PriceSource } from '@mergepilot/engine';
import { getPgModelPrice, listPgModelPrices, pgPricesFetchedAt, replacePgModelPrices } from './pg-prices.js';
import {
  deletePgReviewRuns, finishPgMaintenanceRun, getLatestPgMaintenanceRun, listPgRetentionPolicies, prunePgReviewRuns,
  startPgMaintenanceRun,
} from './pg-maintenance.js';
import { restorePgWorkspace, writePgCredential } from './pg-backup.js';
import { deletePgProviderKeyRows } from './pg-provider-keys.js';
import {
  deletePgAuthPreference, readPgAuthPreference, writePgAuthPreference,
} from './pg-auth-preferences.js';
import {
  listStoredProviderKeys, listWorkspaceStoredProviderKeys, modifyStoredProviderKeys, readStoredKeyCursor,
  recordStoredProviderKeyTest, writeStoredKeyCursor,
} from './pg-key-roster.js';
import { deletePgReviewerBot, listPgReviewerBots, upsertPgReviewerBot } from './pg-bots.js';
import { createPgReviewSkill, deletePgReviewSkill, getPgReviewSkill, listPgReviewSkills, updatePgReviewSkill } from './pg-skills.js';
import { listPgRunGroups } from './pg-run-groups.js';
import {
  createPgReviewRun, findPgActiveReviewRun, listPgLatestFailedRuns, mapReviewRunRow, queryPgReviewRuns,
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

  async saveSettings(settings: WorkspaceSettings, options?: SaveSettingsOptions): Promise<void> {
    return savePgSettings(this.db, settings, options);
  }

  async listReviewerBots(workspaceId: string): Promise<ReviewerBot[]> {
    return listPgReviewerBots(this.db, workspaceId);
  }

  async upsertReviewerBot(workspaceId: string, bot: ReviewerBot): Promise<ReviewerBot> {
    return upsertPgReviewerBot(this.db, workspaceId, bot);
  }

  async deleteReviewerBot(workspaceId: string, slot: number): Promise<boolean> {
    return deletePgReviewerBot(this.db, workspaceId, slot);
  }

  // Review skills (ADR-0034), see pg-skills.ts.
  listReviewSkills = (workspaceId: string): Promise<ReviewSkillSummary[]> => listPgReviewSkills(this.db, workspaceId);
  getReviewSkill = (workspaceId: string, skillId: string): Promise<ReviewSkillRecord | null> => getPgReviewSkill(this.db, workspaceId, skillId);
  createReviewSkill = (workspaceId: string, skill: NewReviewSkill): Promise<ReviewSkillRecord> => createPgReviewSkill(this.db, workspaceId, skill);
  updateReviewSkill = (ws: string, id: string, change: ReviewSkillChange): Promise<ReviewSkillRecord | null> => updatePgReviewSkill(this.db, ws, id, change);
  deleteReviewSkill = (workspaceId: string, skillId: string): Promise<DeletedReviewSkill | null> => deletePgReviewSkill(this.db, workspaceId, skillId);

  async saveCredential(credential: StoredCredential): Promise<void> {
    await withLiveWorkspace(this.db, credential.workspaceId, (tx) => writePgCredential(tx, credential));
  }

  async modifyCredential(workspaceId: string, provider: KeyProvider, change: (current: StoredCredential | null) => Promise<StoredCredential | null>, signal?: AbortSignal): Promise<StoredCredential | null> {
    return withLiveWorkspace(this.db, workspaceId, async (tx) => {
      await lockCredential(tx, workspaceId, provider);
      signal?.throwIfAborted();
      const rows = await tx.select().from(providerCredentials)
        .where(and(eq(providerCredentials.workspaceId, workspaceId), eq(providerCredentials.provider, provider)));
      const row = rows[0];
      const current: StoredCredential | null = row ? { ...row, provider: row.provider as KeyProvider, createdAt: new Date(row.createdAt) } : null;
      const next = await change(current);
      signal?.throwIfAborted();
      if (next && next !== current) await writePgCredential(tx, next);
      else if (!next) {
        await tx.delete(providerCredentials)
          .where(and(eq(providerCredentials.workspaceId, workspaceId), eq(providerCredentials.provider, provider)));
        await deletePgProviderKeyRows(tx, workspaceId, provider);
        await deletePgAuthPreference(tx, workspaceId, provider);
      }
      // Cancellation during the SQL write aborts this transaction before COMMIT.
      signal?.throwIfAborted();
      return next;
    });
  }

  async restoreWorkspace(workspaceId: string, restore: WorkspaceRestore): Promise<void> {
    await restorePgWorkspace(this.db, workspaceId, restore);
  }

  async getCredential(workspaceId: string, provider: KeyProvider): Promise<StoredCredential | null> {
    const rows = await this.db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.workspaceId, workspaceId), eq(providerCredentials.provider, provider)));
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider as KeyProvider,
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
      provider: row.provider as KeyProvider,
      keyVersion: row.keyVersion,
      last4: row.last4,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt),
      baseUrl: row.baseUrl ?? null,
    }));
  }

  async deleteCredential(workspaceId: string, provider: KeyProvider): Promise<void> {
    await this.modifyCredential(workspaceId, provider, async () => null);
  }

  async listProviderKeys(workspaceId: string, provider: KeyProvider): Promise<StoredProviderKey[]> {
    return listStoredProviderKeys(this.db, workspaceId, provider);
  }

  async listWorkspaceProviderKeys(workspaceId: string): Promise<StoredProviderKey[]> {
    return listWorkspaceStoredProviderKeys(this.db, workspaceId);
  }

  async modifyProviderKeys(
    workspaceId: string,
    provider: KeyProvider,
    change: (current: StoredProviderKey[], parent: StoredCredential | null) => Promise<ProviderKeyChange>,
    signal?: AbortSignal,
  ): Promise<StoredProviderKey[]> {
    return modifyStoredProviderKeys(this.db, workspaceId, provider, change, signal);
  }

  async getProviderAuthPreference(workspaceId: string, provider: KeyProvider): Promise<ProviderAuthMethod | null> {
    return readPgAuthPreference(this.db, workspaceId, provider);
  }

  async setProviderAuthPreference(workspaceId: string, provider: KeyProvider, method: ProviderAuthMethod): Promise<void> {
    await withLiveWorkspace(this.db, workspaceId, async (tx) => {
      await lockCredential(tx, workspaceId, provider);
      await writePgAuthPreference(tx, workspaceId, provider, method);
    });
  }

  async deleteProviderAuthPreference(workspaceId: string, provider: KeyProvider): Promise<void> {
    await withLiveWorkspace(this.db, workspaceId, async (tx) => {
      await lockCredential(tx, workspaceId, provider);
      await deletePgAuthPreference(tx, workspaceId, provider);
    });
  }

  async getKeyCursor(workspaceId: string, provider: KeyProvider): Promise<number> {
    return readStoredKeyCursor(this.db, workspaceId, provider);
  }

  async setKeyCursor(workspaceId: string, provider: KeyProvider, keyId: string): Promise<void> {
    await writeStoredKeyCursor(this.db, workspaceId, provider, keyId);
  }

  async recordProviderKeyTest(workspaceId: string, provider: KeyProvider, keyId: string, status: KeyQuotaStatus, testedAt: Date): Promise<boolean> {
    return recordStoredProviderKeyTest(this.db, workspaceId, provider, { keyId, status, testedAt });
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
    botSlot?: number,
  ): Promise<ReviewRun | null> {
    return findPgActiveReviewRun(this.db, workspaceId, repoFullName, pullNumber, headSha, botSlot);
  }

  async listLatestFailedRuns(
    workspaceId: string,
    options?: LatestFailedRunsOptions,
  ): Promise<ReviewRun[]> {
    return listPgLatestFailedRuns(this.db, workspaceId, options);
  }

  async failStaleRuns(heartbeatBefore: Date, onFailed?: (failed: readonly StaleRunRef[]) => void): Promise<number> {
    return failPgStaleRuns(this.db, heartbeatBefore, onFailed);
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

  async replaceModelPrices(source: PriceSource, entries: readonly PriceEntry[], fetchedAt: Date): Promise<number> {
    return replacePgModelPrices(this.db, source, entries, fetchedAt);
  }

  async getModelPrice(provider: string, model: string): Promise<StoredModelPrice | null> {
    return getPgModelPrice(this.db, provider, model);
  }

  async listModelPrices(keys: readonly ModelKey[]): Promise<StoredModelPrice[]> {
    return listPgModelPrices(this.db, keys);
  }

  async pricesFetchedAt(): Promise<Array<{ source: PriceSource; fetchedAt: Date }>> {
    return pgPricesFetchedAt(this.db);
  }

  async deleteWorkspace(workspaceId: string): Promise<{ organizationDeleted: boolean }> {
    // Organization row first, then the workspace data, in one transaction (see deleteWorkspaceInTx).
    await this.db.transaction((tx) => deleteWorkspaceInTx(tx, workspaceId));
    return { organizationDeleted: true };
  }
}

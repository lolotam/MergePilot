import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { InstallationAlreadyLinkedError, WorkspaceDeletedError } from '../core/types.js';
import { organization } from '../auth/schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type {
  ApiProvider,
  AppStore,
  Installation,
  ReviewRun,
  ReviewRunStatus,
  StoredCredential,
  WorkspaceSettings,
} from '../core/types.js';
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
    const result = await this.db
      .update(installations)
      .set({ workspaceId, updatedAt: new Date() })
      .where(
        and(
          eq(installations.id, installationId),
          sql`(${installations.workspaceId} IS NULL OR ${installations.workspaceId} = ${workspaceId})`,
        ),
      )
      .returning();
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
    await this.db
      .insert(workspaceSettings)
      .values({
        workspaceId: settings.workspaceId,
        provider: settings.provider,
        model: settings.model,
        language: settings.language,
        monthlyBudgetUsd: budgetStr,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceSettings.workspaceId,
        set: {
          provider: settings.provider,
          model: settings.model,
          language: settings.language,
          monthlyBudgetUsd: budgetStr,
          updatedAt: new Date(),
        },
      });
  }

  async saveCredential(credential: StoredCredential): Promise<void> {
    await this.db
      .insert(providerCredentials)
      .values({
        id: credential.id,
        workspaceId: credential.workspaceId,
        provider: credential.provider,
        ciphertext: credential.ciphertext,
        keyVersion: credential.keyVersion,
        last4: credential.last4,
        createdBy: credential.createdBy,
        createdAt: credential.createdAt,
      })
      .onConflictDoUpdate({
        target: [providerCredentials.workspaceId, providerCredentials.provider],
        set: {
          id: credential.id,
          ciphertext: credential.ciphertext,
          keyVersion: credential.keyVersion,
          last4: credential.last4,
          createdBy: credential.createdBy,
          createdAt: credential.createdAt,
        },
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
    const id = randomUUID();
    const createdAt = new Date();
    await this.db.transaction(async (tx) => {
      // FOR SHARE: a concurrent deleteWorkspace waits for this insert, or this insert sees the org gone.
      const org = await tx.select({ id: organization.id }).from(organization)
        .where(eq(organization.id, run.workspaceId)).for('share');
      if (org.length === 0) throw new WorkspaceDeletedError(run.workspaceId);
      await tx.insert(reviewRuns).values({
        id,
        workspaceId: run.workspaceId,
        installationId: run.installationId,
        repoFullName: run.repoFullName,
        pullNumber: run.pullNumber,
        headSha: run.headSha,
        status: run.status,
        costUsd: run.costUsd !== null ? String(run.costUsd) : null,
        detail: run.detail,
        createdAt,
        finishedAt: null,
      });
    });
    return {
      ...run,
      id,
      costUsd: run.costUsd !== null ? Number(run.costUsd) : null,
      createdAt,
      finishedAt: null,
    };
  }

  async finishReviewRun(
    workspaceId: string,
    id: string,
    result: { status: ReviewRunStatus; costUsd: number | null; detail: string | null },
  ): Promise<void> {
    await this.db
      .update(reviewRuns)
      .set({
        status: result.status,
        costUsd: result.costUsd !== null ? String(result.costUsd) : null,
        detail: result.detail,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(reviewRuns.id, id),
          eq(reviewRuns.workspaceId, workspaceId),
        ),
      );
  }

  async listReviewRuns(workspaceId: string, limit: number): Promise<ReviewRun[]> {
    const rows = await this.db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.workspaceId, workspaceId))
      .orderBy(desc(reviewRuns.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      installationId: Number(row.installationId),
      repoFullName: row.repoFullName,
      pullNumber: Number(row.pullNumber),
      headSha: row.headSha,
      status: row.status as ReviewRunStatus,
      costUsd: row.costUsd !== null ? Number(row.costUsd) : null,
      detail: row.detail,
      createdAt: new Date(row.createdAt),
      finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
    }));
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
    await this.db.transaction(async (tx) => {
      // Organization first (members/invitations cascade); its row lock serialises createReviewRun.
      await tx.delete(organization).where(eq(organization.id, workspaceId));
      await tx.delete(providerCredentials).where(eq(providerCredentials.workspaceId, workspaceId));
      await tx.delete(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
      await tx.delete(reviewRuns).where(eq(reviewRuns.workspaceId, workspaceId));
      await tx.update(installations).set({ workspaceId: null, updatedAt: new Date() })
        .where(eq(installations.workspaceId, workspaceId));
    });
    return { organizationDeleted: true };
  }
}

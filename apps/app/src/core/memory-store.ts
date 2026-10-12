import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATUSES,
  ActiveRunExistsError,
  InstallationAlreadyLinkedError,
  REUSABLE_RUN_STATUSES,
  WorkspaceDeletedError,
} from './types.js';
import { compareRuns, filterRuns, findActiveRun, selectLatestFailedRuns } from './memory-runs.js';
import {
  addMemoryUsage,
  deleteMemoryRuns,
  finishMemoryMaintenance,
  groupMemoryRuns,
  latestMemoryMaintenance,
  memoryRetentionPolicies,
  pruneMemoryRuns,
  startMemoryMaintenance,
} from './memory-maintenance.js';
import { DEFAULT_RUN_RETENTION_DAYS, usageMonth } from './run-types.js';
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
} from './types.js';

/** In-memory AppStore for tests and local development. Same contract as the Postgres store. */
export class MemoryStore implements AppStore {
  readonly deliveries = new Set<string>();
  readonly installations = new Map<number, Installation | Omit<Installation, 'workspaceId'>>();
  readonly settings = new Map<string, WorkspaceSettings>();
  readonly credentials = new Map<string, StoredCredential>();
  readonly runs = new Map<string, ReviewRun>();
  readonly deletedWorkspaces = new Set<string>();
  /** Monthly usage keyed by workspace id, a NUL separator and `YYYY-MM-01`. */
  readonly usage = new Map<string, MonthlyUsage>();
  readonly maintenance: MaintenanceRun[] = [];

  /** Mirrors the Postgres organization check: no writes for a workspace deleted in this store. */
  private assertLive(workspaceId: string): void {
    if (this.deletedWorkspaces.has(workspaceId)) throw new WorkspaceDeletedError(workspaceId);
  }

  async recordDelivery(deliveryId: string): Promise<boolean> {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.add(deliveryId);
    return true;
  }

  async upsertInstallation(installation: Installation): Promise<void> {
    this.installations.set(installation.id, { ...installation });
  }

  async upsertPendingInstallation(installation: Omit<Installation, 'workspaceId'>): Promise<void> {
    const existing = this.installations.get(installation.id);
    this.installations.set(installation.id, { ...existing, ...installation });
  }

  async linkInstallation(installationId: number, workspaceId: string): Promise<void> {
    this.assertLive(workspaceId);
    const existing = this.installations.get(installationId);
    if (!existing) throw new Error(`installation ${installationId} not found`);
    const current = 'workspaceId' in existing ? existing.workspaceId : undefined;
    if (current && current !== workspaceId) throw new InstallationAlreadyLinkedError(installationId);
    this.installations.set(installationId, { ...existing, workspaceId });
  }

  async getInstallation(installationId: number): Promise<Installation | null> {
    const found = this.installations.get(installationId);
    return found && 'workspaceId' in found && found.workspaceId ? (found as Installation) : null;
  }

  async listInstallations(workspaceId: string): Promise<Installation[]> {
    return [...this.installations.values()].filter(
      (i): i is Installation => 'workspaceId' in i && i.workspaceId === workspaceId,
    );
  }

  async deleteInstallation(installationId: number): Promise<void> {
    this.installations.delete(installationId);
  }

  async setInstallationSuspended(installationId: number, suspended: boolean): Promise<void> {
    const existing = this.installations.get(installationId);
    if (existing) this.installations.set(installationId, { ...existing, suspended });
  }

  async getSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
    const s = this.settings.get(workspaceId);
    if (!s) return null;
    return {
      ...s,
      heavyThresholdLines: s.heavyThresholdLines ?? 800,
      fallback: s.fallback ?? [],
      minSeverity: s.minSeverity ?? 'medium',
      runRetentionDays: s.runRetentionDays === undefined ? DEFAULT_RUN_RETENTION_DAYS : s.runRetentionDays,
      repoColors: { ...(s.repoColors ?? {}) },
    };
  }

  async saveSettings(settings: WorkspaceSettings): Promise<void> {
    this.assertLive(settings.workspaceId);
    // Like the Postgres store: undefined keeps the stored retention and colors.
    const stored = this.settings.get(settings.workspaceId);
    this.settings.set(settings.workspaceId, {
      ...settings,
      runRetentionDays:
        settings.runRetentionDays !== undefined
          ? settings.runRetentionDays
          : stored?.runRetentionDays !== undefined ? stored.runRetentionDays : DEFAULT_RUN_RETENTION_DAYS,
      repoColors: { ...(settings.repoColors ?? stored?.repoColors ?? {}) },
    });
  }

  async saveCredential(credential: StoredCredential): Promise<void> {
    this.assertLive(credential.workspaceId);
    this.credentials.set(`${credential.workspaceId}:${credential.provider}`, { ...credential });
  }

  async getCredential(workspaceId: string, provider: ApiProvider): Promise<StoredCredential | null> {
    return this.credentials.get(`${workspaceId}:${provider}`) ?? null;
  }

  async listCredentials(workspaceId: string): Promise<Array<Omit<StoredCredential, 'ciphertext'>>> {
    return [...this.credentials.values()]
      .filter((c) => c.workspaceId === workspaceId)
      .map(({ ciphertext: _ciphertext, ...rest }) => rest);
  }

  async deleteCredential(workspaceId: string, provider: ApiProvider): Promise<void> {
    this.credentials.delete(`${workspaceId}:${provider}`);
  }

  async createReviewRun(run: NewReviewRun): Promise<ReviewRun> {
    this.assertLive(run.workspaceId);
    const now = new Date();
    const starting = {
      finishedAt: null,
      updatedAt: now,
      costUsd: run.costUsd ?? null,
      detail: run.detail ?? null,
      provider: run.provider ?? null,
      model: run.model ?? null,
      effort: run.effort ?? null,
      fallbackFrom: run.fallbackFrom ?? null,
      findingsCount: run.findingsCount ?? null,
      result: run.result ?? null,
      reviewUrl: run.reviewUrl ?? null,
    };
    let reusable: ReviewRun | undefined;
    if (run.jobId) {
      // Only a queued/running/failed run of this job is reused; completed and skipped runs stay.
      for (const existing of this.runs.values()) {
        if (
          existing.workspaceId === run.workspaceId &&
          existing.jobId === run.jobId &&
          REUSABLE_RUN_STATUSES.includes(existing.status)
        ) {
          reusable = existing;
          break;
        }
      }
    }
    // Emulates the partial unique index of migration 0004: one queued/running run per head.
    if (
      ACTIVE_RUN_STATUSES.includes(run.status) &&
      findActiveRun(this.runs.values(), run, reusable?.id)
    ) {
      throw new ActiveRunExistsError(run.repoFullName, run.pullNumber);
    }
    if (reusable) {
      const updated: ReviewRun = { ...reusable, ...run, ...starting };
      this.runs.set(reusable.id, updated);
      return { ...updated };
    }
    const created: ReviewRun = { ...run, ...starting, id: randomUUID(), createdAt: now };
    this.runs.set(created.id, created);
    return { ...created };
  }

  async touchReviewRun(workspaceId: string, id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.workspaceId !== workspaceId) return;
    if (run.status !== 'queued' && run.status !== 'running') return;
    this.runs.set(id, { ...run, updatedAt: new Date() });
  }

  async finishReviewRun(
    workspaceId: string,
    id: string,
    result: FinishReviewRunOptions,
  ): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.workspaceId !== workspaceId) return;
    const now = new Date();
    const finished: ReviewRun = { ...run, ...result, finishedAt: now, updatedAt: now };
    this.runs.set(id, finished);
    // A run finished twice (e.g. failed by the stale sweep, then finished by its worker) replaces
    // its earlier usage instead of counting twice.
    addMemoryUsage(this.usage, run, -1);
    addMemoryUsage(this.usage, finished);
  }

  async getReviewRun(workspaceId: string, id: string): Promise<ReviewRun | null> {
    const run = this.runs.get(id);
    if (!run || run.workspaceId !== workspaceId) return null;
    return { ...run };
  }

  async listReviewRunRepos(workspaceId: string): Promise<string[]> {
    const repos = new Set<string>();
    for (const r of this.runs.values()) {
      if (r.workspaceId === workspaceId && r.repoFullName) {
        repos.add(r.repoFullName);
      }
    }
    return [...repos].sort();
  }

  async findActiveReviewRun(
    workspaceId: string,
    repoFullName: string,
    pullNumber: number,
    headSha: string,
  ): Promise<ReviewRun | null> {
    const run = findActiveRun(this.runs.values(), { workspaceId, repoFullName, pullNumber, headSha });
    return run ? { ...run } : null;
  }

  async listLatestFailedRuns(
    workspaceId: string,
    options?: LatestFailedRunsOptions,
  ): Promise<ReviewRun[]> {
    return selectLatestFailedRuns(this.runs.values(), workspaceId, options);
  }

  async failStaleRuns(heartbeatBefore: Date): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const [id, r] of this.runs.entries()) {
      if (
        (r.status === 'running' || r.status === 'queued') &&
        r.updatedAt < heartbeatBefore &&
        !this.deletedWorkspaces.has(r.workspaceId)
      ) {
        const failed: ReviewRun = { ...r, status: 'failed', detail: 'interrupted', finishedAt: now, updatedAt: now };
        this.runs.set(id, failed);
        addMemoryUsage(this.usage, { ...failed, costUsd: null, result: null });
        count++;
      }
    }
    return count;
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
    if (typeof limitOrOptions === 'number' || limitOrOptions === undefined) {
      const limit = limitOrOptions ?? 50;
      return [...this.runs.values()]
        .filter((r) => r.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    }

    const opts = limitOrOptions;
    const filtered = filterRuns(this.runs.values(), workspaceId, opts).sort(compareRuns(opts.sort, opts.dir));
    const total = filtered.length;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const sliced = filtered.slice(offset, offset + limit);

    return { runs: sliced, total };
  }

  async monthCostUsd(workspaceId: string, monthStart: Date): Promise<number> {
    const from = usageMonth(monthStart);
    return (await this.listMonthlyUsage(workspaceId))
      .filter((u) => u.month >= from)
      .reduce((sum, u) => sum + u.costUsd, 0);
  }

  async listMonthlyUsage(workspaceId: string): Promise<MonthlyUsage[]> {
    return [...this.usage.values()]
      .filter((u) => u.workspaceId === workspaceId)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((u) => ({ ...u }));
  }

  async listReviewRunGroups(workspaceId: string, options: ListReviewRunsOptions): Promise<ListReviewRunGroupsResult> {
    return groupMemoryRuns(this.runs.values(), workspaceId, options);
  }

  async deleteReviewRuns(workspaceId: string, target: DeleteRunsTarget): Promise<number> {
    this.assertLive(workspaceId);
    return deleteMemoryRuns(this.runs, workspaceId, target);
  }

  async listRetentionPolicies(): Promise<RetentionPolicy[]> {
    return memoryRetentionPolicies(this.runs.values(), this.settings);
  }

  async pruneReviewRuns(workspaceId: string, createdBefore: Date, limit: number): Promise<number> {
    return pruneMemoryRuns(this.runs, workspaceId, createdBefore, limit);
  }

  async startMaintenanceRun(kind: MaintenanceKind, staleBefore: Date): Promise<MaintenanceRun | null> {
    return startMemoryMaintenance(this.maintenance, kind, staleBefore);
  }

  async finishMaintenanceRun(id: string, result: { deletedCount: number; error: string | null }): Promise<void> {
    finishMemoryMaintenance(this.maintenance, id, result);
  }

  async getLatestMaintenanceRun(kind: MaintenanceKind): Promise<MaintenanceRun | null> {
    return latestMemoryMaintenance(this.maintenance, kind);
  }

  async deleteWorkspace(workspaceId: string): Promise<{ organizationDeleted: boolean }> {
    this.deletedWorkspaces.add(workspaceId);
    for (const [key, cred] of this.credentials.entries()) {
      if (cred.workspaceId === workspaceId) {
        this.credentials.delete(key);
      }
    }
    this.settings.delete(workspaceId);
    for (const [key, run] of this.runs.entries()) {
      if (run.workspaceId === workspaceId) {
        this.runs.delete(key);
      }
    }
    for (const [key, row] of this.usage.entries()) {
      if (row.workspaceId === workspaceId) this.usage.delete(key);
    }
    for (const [id, inst] of this.installations.entries()) {
      if ('workspaceId' in inst && inst.workspaceId === workspaceId) {
        const { workspaceId: _, ...unlinked } = inst;
        this.installations.set(id, unlinked);
      }
    }
    return { organizationDeleted: false };
  }
}

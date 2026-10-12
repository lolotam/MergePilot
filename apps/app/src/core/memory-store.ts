import { randomUUID } from 'node:crypto';
import { InstallationAlreadyLinkedError, WorkspaceDeletedError } from './types.js';
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
} from './types.js';

/** In-memory AppStore for tests and local development. Same contract as the Postgres store. */
export class MemoryStore implements AppStore {
  readonly deliveries = new Set<string>();
  readonly installations = new Map<number, Installation | Omit<Installation, 'workspaceId'>>();
  readonly settings = new Map<string, WorkspaceSettings>();
  readonly credentials = new Map<string, StoredCredential>();
  readonly runs = new Map<string, ReviewRun>();
  readonly deletedWorkspaces = new Set<string>();

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
    return this.settings.get(workspaceId) ?? null;
  }

  async saveSettings(settings: WorkspaceSettings): Promise<void> {
    this.assertLive(settings.workspaceId);
    this.settings.set(settings.workspaceId, { ...settings });
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

  async createReviewRun(
    run: Omit<ReviewRun, 'id' | 'createdAt' | 'finishedAt'>,
  ): Promise<ReviewRun> {
    this.assertLive(run.workspaceId);
    if (run.jobId) {
      for (const existing of this.runs.values()) {
        if (existing.workspaceId === run.workspaceId && existing.jobId === run.jobId) {
          const updated: ReviewRun = {
            ...existing,
            ...run,
            status: run.status,
            headSha: run.headSha,
            costUsd: run.costUsd ?? null,
            detail: run.detail ?? null,
            finishedAt: null,
          };
          this.runs.set(existing.id, updated);
          return updated;
        }
      }
    }
    const created: ReviewRun = {
      ...run,
      id: randomUUID(),
      createdAt: new Date(),
      finishedAt: null,
    };
    this.runs.set(created.id, created);
    return created;
  }

  async finishReviewRun(
    workspaceId: string,
    id: string,
    result: FinishReviewRunOptions,
  ): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.workspaceId !== workspaceId) return;
    this.runs.set(id, {
      ...run,
      ...result,
      finishedAt: new Date(),
    });
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

  async failStaleRuns(olderThan: Date): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const [id, r] of this.runs.entries()) {
      if (
        (r.status === 'running' || r.status === 'queued') &&
        r.createdAt < olderThan &&
        !this.deletedWorkspaces.has(r.workspaceId)
      ) {
        this.runs.set(id, {
          ...r,
          status: 'failed',
          detail: 'interrupted',
          finishedAt: now,
        });
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
    let filtered = [...this.runs.values()].filter((r) => r.workspaceId === workspaceId);

    if (opts.repo && opts.repo.length > 0) {
      const allowed = new Set(opts.repo);
      filtered = filtered.filter((r) => allowed.has(r.repoFullName));
    }
    if (opts.status && opts.status.length > 0) {
      const allowed = new Set(opts.status);
      filtered = filtered.filter((r) => allowed.has(r.status));
    }
    if (opts.from) {
      filtered = filtered.filter((r) => r.createdAt >= opts.from!);
    }
    if (opts.to) {
      filtered = filtered.filter((r) => r.createdAt <= opts.to!);
    }
    if (opts.provider) {
      filtered = filtered.filter((r) => r.provider === opts.provider);
    }
    if (opts.q && opts.q.trim().length > 0) {
      const qLower = opts.q.trim().toLowerCase();
      filtered = filtered.filter((r) => {
        const repo = r.repoFullName.toLowerCase();
        const pr = String(r.pullNumber);
        const model = (r.model ?? '').toLowerCase();
        const detail = (r.detail ?? '').toLowerCase();
        return (
          repo.includes(qLower) ||
          pr.includes(qLower) ||
          model.includes(qLower) ||
          detail.includes(qLower)
        );
      });
    }

    const sortKey = opts.sort ?? 'createdAt';
    const isAsc = opts.dir === 'asc';

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'createdAt':
          cmp = a.createdAt.getTime() - b.createdAt.getTime();
          break;
        case 'repo':
          cmp = a.repoFullName.localeCompare(b.repoFullName);
          break;
        case 'pullNumber':
          cmp = a.pullNumber - b.pullNumber;
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        case 'provider':
          cmp = (a.provider ?? '').localeCompare(b.provider ?? '');
          break;
        case 'model':
          cmp = (a.model ?? '').localeCompare(b.model ?? '');
          break;
        case 'findingsCount':
          cmp = (a.findingsCount ?? 0) - (b.findingsCount ?? 0);
          break;
        case 'costUsd':
          cmp = (a.costUsd ?? 0) - (b.costUsd ?? 0);
          break;
        case 'duration': {
          const durA = (a.finishedAt?.getTime() ?? a.createdAt.getTime()) - a.createdAt.getTime();
          const durB = (b.finishedAt?.getTime() ?? b.createdAt.getTime()) - b.createdAt.getTime();
          cmp = durA - durB;
          break;
        }
      }
      if (cmp !== 0) return isAsc ? cmp : -cmp;
      return a.id.localeCompare(b.id);
    });

    const total = filtered.length;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const sliced = filtered.slice(offset, offset + limit);

    return { runs: sliced, total };
  }

  async monthCostUsd(workspaceId: string, monthStart: Date): Promise<number> {
    return [...this.runs.values()]
      .filter((r) => r.workspaceId === workspaceId && r.createdAt >= monthStart)
      .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
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
    for (const [id, inst] of this.installations.entries()) {
      if ('workspaceId' in inst && inst.workspaceId === workspaceId) {
        const { workspaceId: _, ...unlinked } = inst;
        this.installations.set(id, unlinked);
      }
    }
    return { organizationDeleted: false };
  }
}

import { randomUUID } from 'node:crypto';
import { InstallationAlreadyLinkedError, WorkspaceDeletedError } from './types.js';
import type {
  ApiProvider,
  AppStore,
  Installation,
  ReviewRun,
  ReviewRunStatus,
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

  async createReviewRun(run: Omit<ReviewRun, 'id' | 'createdAt' | 'finishedAt'>): Promise<ReviewRun> {
    this.assertLive(run.workspaceId);
    const created: ReviewRun = { ...run, id: randomUUID(), createdAt: new Date(), finishedAt: null };
    this.runs.set(created.id, created);
    return created;
  }

  async finishReviewRun(
    workspaceId: string,
    id: string,
    result: { status: ReviewRunStatus; costUsd: number | null; detail: string | null },
  ): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.workspaceId !== workspaceId) return;
    this.runs.set(id, { ...run, ...result, finishedAt: new Date() });
  }

  async listReviewRuns(workspaceId: string, limit: number): Promise<ReviewRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
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

import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_WORKSPACE_MAX_FINDINGS, InstallationAlreadyLinkedError, type SaveSettingsOptions, SettingsChangedError, WorkspaceDeletedError } from './types.js';
import { memoryActiveRun, memoryApiEquivalentRows, memoryRunRepos } from './memory-run-queries.js';
import {
  memoryCreateReviewRun,
  memoryFailStaleRuns,
  memoryFinishReviewRun,
  memoryListLatestFailedRuns,
  memoryListReviewRuns,
  memoryTouchReviewRun,
  type MemoryRunTables,
} from './memory-store-runs.js';
import {
  deleteMemoryBot, keepPanelSettings, listMemoryBots, panelSettingsOrDefaults,
  upsertMemoryBot,
} from './memory-bots.js';
import { BotNameTakenError, sameBotName, type ReviewerBot } from './bot-types.js';
import { deleteMemoryWorkspace, restoreMemoryWorkspace } from './memory-workspace.js';
import {
  assertMemorySkill, createMemorySkill, deleteMemorySkill, getMemorySkill, listMemorySkills, updateMemorySkill,
  withSetSkillFields, type MemorySkills,
} from './memory-skills.js';
import type { DeletedReviewSkill, NewReviewSkill, ReviewSkillChange, ReviewSkillRecord, ReviewSkillSummary } from './skill-types.js';
import {
  listMemoryProviderKeys, listMemoryWorkspaceProviderKeys, modifyMemoryProviderKeys, readMemoryKeyCursor,
  recordMemoryProviderKeyTest, writeMemoryKeyCursor,
} from './memory-provider-keys.js';
import {
  deleteMemoryAuthPreference, readMemoryAuthPreference, writeMemoryAuthPreference,
} from './memory-auth-preferences.js';
import {
  deleteMemoryRuns, finishMemoryMaintenance, groupMemoryRuns, latestMemoryMaintenance,
  memoryRetentionPolicies, pruneMemoryRuns, startMemoryMaintenance,
} from './memory-maintenance.js';
import { DEFAULT_RUN_RETENTION_DAYS, usageMonth } from './run-types.js';
import type { PriceEntry, PriceSource } from '@mergepilot/engine';
import { MemoryPriceTable } from './memory-prices.js';
import type { ModelKey, StoredModelPrice } from './price-types.js';
import type {
  KeyProvider, AppStore, DeleteRunsTarget, FinishReviewRunOptions, Installation, LatestFailedRunsOptions,
  ListReviewRunGroupsResult, ListReviewRunsOptions, ListReviewRunsResult, MaintenanceKind, MaintenanceRun,
  MonthlyUsage, NewReviewRun, RetentionPolicy, ReviewRun, StaleRunRef, StoredCredential, StoredProviderKey,
  ProviderKeyChange, KeyQuotaStatus, ProviderAuthMethod, WorkspaceRestore, WorkspaceSettings, ApiEquivalentRunRow,
} from './types.js';
/** In-memory AppStore for tests and local development. Same contract as the Postgres store. */
export class MemoryStore implements AppStore {
  readonly deliveries = new Set<string>();
  readonly installations = new Map<number, Installation | Omit<Installation, 'workspaceId'>>();
  readonly settings = new Map<string, WorkspaceSettings>();
  readonly credentials = new Map<string, StoredCredential>();
  /** Ordered slot rows, keyed like `credentials` (`workspaceId:provider`). */
  readonly providerKeys = new Map<string, StoredProviderKey[]>();
  /** Last successful 0-based key index. Missing means the next call starts at 0. */
  readonly keyCursors = new Map<string, number>();
  readonly authPreferences = new Map<string, ProviderAuthMethod>();
  private readonly credentialLocks = new Map<string, Promise<void>>();
  readonly runs = new Map<string, ReviewRun>();
  readonly deletedWorkspaces = new Set<string>();
  /** Monthly usage keyed by workspace id, a NUL separator and `YYYY-MM-01`. */
  readonly usage = new Map<string, MonthlyUsage>();
  readonly maintenance: MaintenanceRun[] = [];
  readonly prices = new MemoryPriceTable();
  /** Extra reviewer-panel bots (slots 2-5), see memory-bots.ts. */
  readonly bots = new Map<string, ReviewerBot>();
  /** Review skills by id (ADR-0034), see memory-skills.ts. */
  readonly skills: MemorySkills = new Map();

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
    return this.readSettings(workspaceId);
  }

  private readSettings(workspaceId: string): WorkspaceSettings | null {
    const s = this.settings.get(workspaceId);
    if (!s) return null;
    return withSetSkillFields({
      ...s,
      heavyThresholdLines: s.heavyThresholdLines ?? 800,
      fallback: s.fallback ?? [],
      minSeverity: s.minSeverity ?? 'medium',
      maxFindings: s.maxFindings ?? DEFAULT_WORKSPACE_MAX_FINDINGS,
      perReviewUsd: s.perReviewUsd ?? 0.5,
      exploreEnabled: s.exploreEnabled ?? false,
      callTimeoutMs: s.callTimeoutMs ?? null,
      runRetentionDays: s.runRetentionDays === undefined ? DEFAULT_RUN_RETENTION_DAYS : s.runRetentionDays,
      repoColors: { ...(s.repoColors ?? {}) },
      judge: s.judge ? { ...s.judge, uses: [...s.judge.uses], fallback: [...s.judge.fallback] } : null,
      priceOverrides: (s.priceOverrides ?? []).map((o) => ({ ...o })),
      ...panelSettingsOrDefaults(s),
    });
  }

  async saveSettings(settings: WorkspaceSettings, options?: SaveSettingsOptions): Promise<void> {
    this.assertLive(settings.workspaceId);
    if (options?.expected !== undefined && !isDeepStrictEqual(this.readSettings(settings.workspaceId), options.expected)) {
      throw new SettingsChangedError(settings.workspaceId);
    }
    // Like the Postgres store: undefined keeps the stored retention, colors, judge and price overrides,
    // and only a renamed main bot is checked against the extra bots' names.
    const stored = this.settings.get(settings.workspaceId);
    assertMemorySkill(this.skills, settings.workspaceId, settings.skillId);
    const botName = settings.botName;
    const renamed = botName !== undefined && !(stored?.botName && sameBotName(stored.botName, botName));
    if (renamed && listMemoryBots(this.bots, settings.workspaceId).some((bot) => sameBotName(bot.name, botName))) {
      throw new BotNameTakenError(botName);
    }
    this.settings.set(settings.workspaceId, {
      ...settings,
      maxFindings: settings.maxFindings ?? stored?.maxFindings,
      perReviewUsd: settings.perReviewUsd ?? stored?.perReviewUsd,
      exploreEnabled: settings.exploreEnabled ?? stored?.exploreEnabled ?? false,
      runRetentionDays:
        settings.runRetentionDays !== undefined
          ? settings.runRetentionDays
          : stored?.runRetentionDays !== undefined ? stored.runRetentionDays : DEFAULT_RUN_RETENTION_DAYS,
      repoColors: { ...(settings.repoColors ?? stored?.repoColors ?? {}) },
      judge: settings.judge !== undefined ? settings.judge : (stored?.judge ?? null),
      priceOverrides: (settings.priceOverrides ?? stored?.priceOverrides ?? []).map((o) => ({ ...o })),
      ...keepPanelSettings(settings, stored),
      // A skill choice (null included) clears the deleted-skill note; undefined keeps both (ADR-0034).
      skillId: settings.skillId !== undefined ? settings.skillId : (stored?.skillId ?? null),
      skillRemovedName: settings.skillId !== undefined ? null : (stored?.skillRemovedName ?? null),
      // An omitted timeout keeps the stored one; an explicit null resets to inherit; a number overrides.
      callTimeoutMs: settings.callTimeoutMs !== undefined ? settings.callTimeoutMs : (stored?.callTimeoutMs ?? null),
    });
  }

  async listReviewerBots(workspaceId: string): Promise<ReviewerBot[]> {
    return listMemoryBots(this.bots, workspaceId);
  }

  async upsertReviewerBot(workspaceId: string, bot: ReviewerBot): Promise<ReviewerBot> {
    this.assertLive(workspaceId);
    assertMemorySkill(this.skills, workspaceId, bot.skillId);
    // Like Postgres: a skill or exploration flag left out keeps its stored value.
    const stored = bot.skillId === undefined || bot.exploreEnabled === undefined || bot.callTimeoutMs === undefined
      ? listMemoryBots(this.bots, workspaceId).find((b) => b.slot === bot.slot)
      : undefined;
    const next = stored
      ? {
          ...bot,
          exploreEnabled: bot.exploreEnabled ?? stored.exploreEnabled,
          callTimeoutMs: bot.callTimeoutMs !== undefined ? bot.callTimeoutMs : (stored?.callTimeoutMs ?? null),
          ...(bot.skillId === undefined
            ? { skillId: stored.skillId ?? null, skillRemovedName: stored.skillRemovedName ?? null }
            : {}),
        }
      : { ...bot, exploreEnabled: bot.exploreEnabled ?? false, callTimeoutMs: bot.callTimeoutMs !== undefined ? bot.callTimeoutMs : null };
    return upsertMemoryBot(this.bots, workspaceId, next, this.settings.get(workspaceId)?.botName);
  }

  async listReviewSkills(workspaceId: string): Promise<ReviewSkillSummary[]> {
    return listMemorySkills(this.skills, workspaceId);
  }

  async getReviewSkill(workspaceId: string, skillId: string): Promise<ReviewSkillRecord | null> {
    return getMemorySkill(this.skills, workspaceId, skillId);
  }

  async createReviewSkill(workspaceId: string, skill: NewReviewSkill): Promise<ReviewSkillRecord> {
    this.assertLive(workspaceId);
    return createMemorySkill(this.skills, workspaceId, skill);
  }

  async updateReviewSkill(workspaceId: string, skillId: string, change: ReviewSkillChange): Promise<ReviewSkillRecord | null> {
    this.assertLive(workspaceId);
    return updateMemorySkill(this.skills, workspaceId, skillId, change);
  }

  async deleteReviewSkill(workspaceId: string, skillId: string): Promise<DeletedReviewSkill | null> {
    return deleteMemorySkill(this.skills, workspaceId, skillId, {
      settings: this.settings,
      extras: listMemoryBots(this.bots, workspaceId),
      saveExtra: (bot) => upsertMemoryBot(this.bots, workspaceId, bot, this.settings.get(workspaceId)?.botName),
    });
  }

  async deleteReviewerBot(workspaceId: string, slot: number): Promise<boolean> {
    return deleteMemoryBot(this.bots, workspaceId, slot);
  }

  async restoreWorkspace(workspaceId: string, restore: WorkspaceRestore): Promise<void> {
    this.assertLive(workspaceId);
    await restoreMemoryWorkspace(this, workspaceId, restore);
  }

  async saveCredential(credential: StoredCredential): Promise<void> {
    await this.modifyCredential(credential.workspaceId, credential.provider, async () => ({ ...credential }));
  }

  private async withCredentialLock<T>(workspaceId: string, provider: string, work: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}:${provider}`;
    const previous = this.credentialLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.credentialLocks.set(key, lock);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.credentialLocks.get(key) === lock) this.credentialLocks.delete(key);
    }
  }

  async modifyCredential(workspaceId: string, provider: KeyProvider, change: (current: StoredCredential | null) => Promise<StoredCredential | null>, signal?: AbortSignal): Promise<StoredCredential | null> {
    return this.withCredentialLock(workspaceId, provider, async () => {
      signal?.throwIfAborted();
      this.assertLive(workspaceId);
      const key = `${workspaceId}:${provider}`;
      const next = await change(this.credentials.get(key) ?? null);
      signal?.throwIfAborted();
      this.assertLive(workspaceId);
      if (next) this.credentials.set(key, { ...next });
      else {
        this.credentials.delete(key);
        this.providerKeys.delete(key);
        this.keyCursors.delete(key);
        deleteMemoryAuthPreference(this, workspaceId, provider);
      }
      return next;
    });
  }

  async getCredential(workspaceId: string, provider: KeyProvider): Promise<StoredCredential | null> {
    return this.credentials.get(`${workspaceId}:${provider}`) ?? null;
  }

  async listCredentials(workspaceId: string): Promise<Array<Omit<StoredCredential, 'ciphertext'>>> {
    return [...this.credentials.values()]
      .filter((c) => c.workspaceId === workspaceId)
      .map(({ ciphertext: _ciphertext, ...rest }) => rest);
  }

  async deleteCredential(workspaceId: string, provider: KeyProvider): Promise<void> {
    await this.modifyCredential(workspaceId, provider, async () => null);
  }

  async listProviderKeys(workspaceId: string, provider: KeyProvider): Promise<StoredProviderKey[]> {
    return listMemoryProviderKeys(this, workspaceId, provider);
  }

  async listWorkspaceProviderKeys(workspaceId: string): Promise<StoredProviderKey[]> {
    return listMemoryWorkspaceProviderKeys(this, workspaceId);
  }

  async modifyProviderKeys(
    workspaceId: string,
    provider: KeyProvider,
    change: (current: StoredProviderKey[], parent: StoredCredential | null) => Promise<ProviderKeyChange>,
    signal?: AbortSignal,
  ): Promise<StoredProviderKey[]> {
    return modifyMemoryProviderKeys(this.keyLock(workspaceId, provider), workspaceId, provider, change, signal);
  }

  async getProviderAuthPreference(workspaceId: string, provider: KeyProvider): Promise<ProviderAuthMethod | null> {
    return readMemoryAuthPreference(this, workspaceId, provider);
  }

  async setProviderAuthPreference(workspaceId: string, provider: KeyProvider, method: ProviderAuthMethod): Promise<void> {
    await this.withCredentialLock(workspaceId, provider, async () => {
      this.assertLive(workspaceId);
      writeMemoryAuthPreference(this, workspaceId, provider, method);
    });
  }

  async deleteProviderAuthPreference(workspaceId: string, provider: KeyProvider): Promise<void> {
    await this.withCredentialLock(workspaceId, provider, async () => {
      deleteMemoryAuthPreference(this, workspaceId, provider);
    });
  }

  async getKeyCursor(workspaceId: string, provider: KeyProvider): Promise<number> {
    return readMemoryKeyCursor(this, workspaceId, provider);
  }

  async setKeyCursor(workspaceId: string, provider: KeyProvider, keyId: string): Promise<void> {
    await writeMemoryKeyCursor(this.keyLock(workspaceId, provider), workspaceId, provider, keyId);
  }

  async recordProviderKeyTest(workspaceId: string, provider: KeyProvider, keyId: string, status: KeyQuotaStatus, testedAt: Date): Promise<boolean> {
    return recordMemoryProviderKeyTest(this.keyLock(workspaceId, provider), workspaceId, provider, { keyId, status, testedAt });
  }

  /** Tables plus the per-provider lock. The lock is not re-entrant, so helpers must not call back into the store. */
  private keyLock(workspaceId: string, provider: KeyProvider) {
    return {
      tables: this,
      runLocked: <T>(work: () => Promise<T>) => this.withCredentialLock(workspaceId, provider, work),
      assertLive: (id: string) => this.assertLive(id),
    };
  }

  private runTables(): MemoryRunTables {
    return this as MemoryStore & MemoryRunTables;
  }

  async createReviewRun(run: NewReviewRun): Promise<ReviewRun> {
    return memoryCreateReviewRun(this.runTables(), run);
  }

  async touchReviewRun(workspaceId: string, id: string): Promise<void> {
    memoryTouchReviewRun(this.runTables(), workspaceId, id);
  }

  async finishReviewRun(
    workspaceId: string,
    id: string,
    result: FinishReviewRunOptions,
  ): Promise<void> {
    memoryFinishReviewRun(this.runTables(), workspaceId, id, result);
  }

  async getReviewRun(workspaceId: string, id: string): Promise<ReviewRun | null> {
    const run = this.runs.get(id);
    if (!run || run.workspaceId !== workspaceId) return null;
    return { ...run };
  }

  async listApiEquivalentRuns(workspaceId: string, providers: readonly string[]): Promise<ApiEquivalentRunRow[]> {
    return memoryApiEquivalentRows(this.runs, workspaceId, providers);
  }

  async listReviewRunRepos(workspaceId: string): Promise<string[]> {
    return memoryRunRepos(this.runs, workspaceId);
  }

  async findActiveReviewRun(
    workspaceId: string,
    repoFullName: string,
    pullNumber: number,
    headSha: string,
    botSlot?: number,
  ): Promise<ReviewRun | null> {
    return memoryActiveRun(this.runs, workspaceId, repoFullName, pullNumber, headSha, botSlot);
  }

  async listLatestFailedRuns(
    workspaceId: string,
    options?: LatestFailedRunsOptions,
  ): Promise<ReviewRun[]> {
    return memoryListLatestFailedRuns(this.runTables(), workspaceId, options);
  }

  async failStaleRuns(heartbeatBefore: Date, onFailed?: (failed: readonly StaleRunRef[]) => void): Promise<number> {
    return memoryFailStaleRuns(this.runTables(), heartbeatBefore, onFailed);
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
    return memoryListReviewRuns(this.runTables(), workspaceId, limitOrOptions);
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

  async replaceModelPrices(source: PriceSource, entries: readonly PriceEntry[], fetchedAt: Date): Promise<number> {
    return this.prices.replace(source, entries, fetchedAt);
  }

  async getModelPrice(provider: string, model: string): Promise<StoredModelPrice | null> {
    return this.prices.get(provider, model);
  }

  async listModelPrices(keys: readonly ModelKey[]): Promise<StoredModelPrice[]> {
    return this.prices.list(keys);
  }

  async pricesFetchedAt(): Promise<Array<{ source: PriceSource; fetchedAt: Date }>> {
    return this.prices.fetchedAt();
  }

  async deleteWorkspace(workspaceId: string): Promise<{ organizationDeleted: boolean }> {
    deleteMemoryWorkspace(this, workspaceId);
    return { organizationDeleted: false };
  }
}

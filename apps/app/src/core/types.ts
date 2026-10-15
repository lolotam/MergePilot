import type {
  ApiProviderId, CredentialStore, JudgeKeyOnlyProviderId, JudgeMode, JudgeProviderId, JudgeUse, MergePilotConfig,
  ReviewModel, Severity,
} from '@mergepilot/engine';
import type { BackupRestoreStore } from './backup-types.js';
import type { ModelPriceStore, PriceOverride, RunPricing } from './price-types.js';
import type { BotLogo, PanelMode, ReviewerBotStore } from './bot-types.js';
import type { RepoColorKey, RunMaintenanceStore } from './run-types.js';

export * from './backup-types.js';
export * from './bot-types.js';
export * from './run-types.js';
export * from './price-types.js';

/** Workspace roles (ADR-0007). Order matters: each role includes everything below it. */
export const ROLES = ['member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/** Thrown by AppStore.linkInstallation when another workspace already owns the installation. */
export class InstallationAlreadyLinkedError extends Error {
  constructor(installationId: number) {
    super(`installation ${installationId} is already linked to another workspace`);
    this.name = 'InstallationAlreadyLinkedError';
  }
}

/** Thrown when a write targets a workspace that was deleted (or never existed in Postgres). */
export class WorkspaceDeletedError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} no longer exists`);
    this.name = 'WorkspaceDeletedError';
  }
}

/**
 * Thrown by AppStore.createReviewRun when another run for the same workspace, repo, PR, head
 * commit and bot slot is already `queued` or `running` (one active run per head and bot; ADR-0009
 * amendment, ADR-0017).
 */
export class ActiveRunExistsError extends Error {
  constructor(repoFullName: string, pullNumber: number, readonly botSlot = 1) {
    const bot = botSlot === 1 ? '' : ` (bot ${botSlot})`;
    super(`a review run for ${repoFullName}#${pullNumber}${bot} at this commit is already queued or running`);
    this.name = 'ActiveRunExistsError';
  }
}

/** Only these statuses count as active for the one-active-run-per-head rule. */
export const ACTIVE_RUN_STATUSES: readonly ReviewRunStatus[] = ['queued', 'running'];

export type ApiProvider = ApiProviderId;

/** Every provider a workspace may store a key for: review providers plus the Jev-only key types (ADR-0015). */
export type KeyProvider = ApiProviderId | JudgeKeyOnlyProviderId;

export interface FallbackSetting {
  provider: ApiProvider;
  model: string;
  effort?: string | null | undefined;
}

export interface Installation {
  /** GitHub installation id. */
  id: number;
  workspaceId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

export interface WorkspaceSettings {
  workspaceId: string;
  provider: ApiProvider;
  model: string;
  language: 'ar' | 'en';
  monthlyBudgetUsd: number | null;
  effort?: string | null | undefined;
  heavyProvider?: ApiProvider | null | undefined;
  heavyModel?: string | null | undefined;
  heavyEffort?: string | null | undefined;
  heavyThresholdLines?: number | null | undefined;
  fallback?: FallbackSetting[] | undefined;
  minSeverity?: Severity | undefined;
  /**
   * Days to keep review runs (ADR-0014); null keeps them forever. Stores always read back a value
   * (30 by default); undefined on save keeps the stored value.
   */
  runRetentionDays?: number | null | undefined;
  /** Chosen palette color per `owner/repo`; repos left out use the default (hashed) color. */
  repoColors?: Record<string, RepoColorKey> | undefined;
  /** The Jev judge (ADR-0015); null / undefined = never configured (off). */
  judge?: JudgeSettings | null | undefined;
  /** Manual model prices (ADR-0016); stores read back [] by default, undefined on save keeps them. */
  priceOverrides?: PriceOverride[] | undefined;
  /**
   * The reviewer panel (ADR-0017): the main bot's name and logo, and how the panel publishes.
   * Stores always read back a value (the defaults); undefined on save keeps the stored value.
   */
  botName?: string | undefined;
  botLogo?: BotLogo | undefined;
  panelMode?: PanelMode | undefined;
  panelMinAgreement?: number | undefined;
}

/** The Jev judge of a workspace: the configured provider plus up to three explicit fallbacks. */
export interface JudgeSettings {
  enabled: boolean;
  provider: JudgeProviderId;
  model: string;
  /** Zero or more uses (ADR-0015 multi-use); empty with `enabled` = an idle judge. */
  uses: JudgeUse[];
  threshold: number;
  fallback: Array<{ provider: JudgeProviderId; model: string }>;
}

export interface StoredCredential {
  id: string;
  workspaceId: string;
  provider: KeyProvider;
  /** Envelope-encrypted secret (see Vault). Never the plaintext. */
  ciphertext: string;
  keyVersion: number;
  /** Last 4 characters, for display only. */
  last4: string;
  createdBy: string;
  createdAt: Date;
  baseUrl?: string | null | undefined;
}

/** Last provider test of one stored API key (ADR-0026). Never a secret. */
export type KeyQuotaStatus = 'valid' | 'invalid' | 'quota-exhausted';

/** One encrypted key in a provider's ordered list. Position 0 is also the parent credential. */
export interface StoredProviderKey {
  id: string;
  workspaceId: string;
  provider: KeyProvider;
  position: number;
  /** Same vault envelope as `StoredCredential.ciphertext`. Never the plaintext. */
  ciphertext: string;
  keyVersion: number;
  last4: string;
  createdBy: string;
  createdAt: Date;
  lastTestStatus: KeyQuotaStatus | null;
  lastTestedAt: Date | null;
}

/**
 * One locked update of a provider's key list. `parent` upserts the parent credential,
 * null deletes it, and undefined leaves it. `cursor` is clamped into range; undefined
 * clamps a stored cursor and leaves a missing one missing.
 */
export interface ProviderKeyChange {
  keys: StoredProviderKey[];
  parent?: StoredCredential | null | undefined;
  cursor?: number | undefined;
}

export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'skipped' | 'failed';

export interface ReviewRunFinding {
  path: string;
  line?: number;
  endLine?: number;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category?: string;
  title: string;
  body: string;
  suggestion?: string;
  truncated?: boolean;
}

export interface ReviewRunResultPayload {
  v: 1;
  summary: string;
  highlights: string[];
  findings: ReviewRunFinding[];
  outOfDiff?: ReviewRunFinding[];
  language: 'ar' | 'en';
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  verify?: {
    dropped: number;
  };
  /** What the Jev judge did on this run (ADR-0015); its tokens are also in `usage`. */
  judge?: ReviewRunJudge | undefined;
  /** Which source priced the primary model (ADR-0016). */
  pricing?: RunPricing | undefined;
  /** Which API key answered, and how many were skipped for quota (ADR-0026). Never the key. */
  keyRotation?: Array<{ provider: string; keyIndex: number; skipped: number }> | undefined;
}

export interface ReviewRunJudge {
  /** The configured uses. Absent on runs recorded before multi-use, which carry `mode`. */
  uses?: JudgeUse[] | undefined;
  /** Only on runs recorded before multi-use. */
  mode?: JudgeMode | undefined;
  threshold: number;
  checked: number;
  filtered: Array<{ title: string; path: string; line: number; noul: number }>;
  duplicatesDropped: number;
  answeredBy?: string | undefined;
  unavailable?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | undefined;
  attempts: Array<{ provider: string; model: string; ok: boolean; code?: string | undefined; ms: number; skipped?: boolean | undefined }>;
}

export interface ReviewRun {
  id: string;
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  status: ReviewRunStatus;
  costUsd: number | null;
  detail: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** Heartbeat: set on create, on every status change, and periodically while the review runs. */
  updatedAt: Date;
  jobId?: string | null | undefined;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  effort?: string | null | undefined;
  fallbackFrom?: string | null | undefined;
  findingsCount?: number | null | undefined;
  result?: ReviewRunResultPayload | null | undefined;
  reviewUrl?: string | null | undefined;
  /** The reviewer-panel bot (ADR-0017): 1-5, 1 = the main bot. Stores read back 1 by default. */
  botSlot?: number | undefined;
  /** The bot's name when the run was created; null when not recorded. */
  botName?: string | null | undefined;
}

/** A run as the worker records it; the store assigns id and timestamps. */
export type NewReviewRun = Omit<ReviewRun, 'id' | 'createdAt' | 'finishedAt' | 'updatedAt'>;

/** Only runs in these states may be reused by a retry of the same job id. */
export const REUSABLE_RUN_STATUSES: readonly ReviewRunStatus[] = ['queued', 'running', 'failed'];

export interface LatestFailedRunsOptions {
  repo?: string[] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
}

export interface FinishReviewRunOptions {
  status: ReviewRunStatus;
  costUsd: number | null;
  detail: string | null;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  effort?: string | null | undefined;
  fallbackFrom?: string | null | undefined;
  findingsCount?: number | null | undefined;
  result?: ReviewRunResultPayload | null | undefined;
  reviewUrl?: string | null | undefined;
}

export interface ListReviewRunsOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  repo?: string[] | undefined;
  status?: ReviewRunStatus[] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  provider?: string | undefined;
  q?: string | undefined;
  sort?:
    | 'createdAt'
    | 'repo'
    | 'pullNumber'
    | 'status'
    | 'provider'
    | 'model'
    | 'findingsCount'
    | 'costUsd'
    | 'inputTokens'
    | 'outputTokens'
    | 'duration'
    | undefined;
  dir?: 'asc' | 'desc' | undefined;
}

export interface ListReviewRunsResult {
  runs: ReviewRun[];
  total: number;
}

/** Data access. Every workspace-owned read/write takes the workspaceId it is scoped to. */
export interface AppStore extends RunMaintenanceStore, ModelPriceStore, ReviewerBotStore, BackupRestoreStore {
  /** Returns false when this delivery id was already recorded (duplicate webhook). */
  recordDelivery(deliveryId: string, event: string): Promise<boolean>;

  upsertInstallation(installation: Installation): Promise<void>;
  /** Installation created on GitHub but not yet linked to a workspace. */
  upsertPendingInstallation(installation: Omit<Installation, 'workspaceId'>): Promise<void>;
  linkInstallation(installationId: number, workspaceId: string): Promise<void>;
  getInstallation(installationId: number): Promise<Installation | null>;
  listInstallations(workspaceId: string): Promise<Installation[]>;
  deleteInstallation(installationId: number): Promise<void>;
  setInstallationSuspended(installationId: number, suspended: boolean): Promise<void>;

  getSettings(workspaceId: string): Promise<WorkspaceSettings | null>;
  saveSettings(settings: WorkspaceSettings): Promise<void>;

  saveCredential(credential: StoredCredential): Promise<void>;
  /** Serialized across processes in Postgres, including login, deletion and OAuth refresh. Null deletes. */
  modifyCredential(workspaceId: string, provider: KeyProvider, change: (current: StoredCredential | null) => Promise<StoredCredential | null>, signal?: AbortSignal): Promise<StoredCredential | null>;
  getCredential(workspaceId: string, provider: KeyProvider): Promise<StoredCredential | null>;
  listCredentials(workspaceId: string): Promise<Array<Omit<StoredCredential, 'ciphertext'>>>;
  deleteCredential(workspaceId: string, provider: KeyProvider): Promise<void>;

  /** Ordered keys for one provider. Empty when that provider has no slot rows. */
  listProviderKeys(workspaceId: string, provider: KeyProvider): Promise<StoredProviderKey[]>;
  /** Every slot row of the workspace, for listing and vault rotation. */
  listWorkspaceProviderKeys(workspaceId: string): Promise<StoredProviderKey[]>;
  /**
   * Replaces the slot list under the same lock as `modifyCredential`. When `change` throws,
   * nothing is written. A null parent deletes the parent credential as well.
   */
  modifyProviderKeys(
    workspaceId: string,
    provider: KeyProvider,
    change: (current: StoredProviderKey[]) => Promise<ProviderKeyChange>,
  ): Promise<StoredProviderKey[]>;
  /** 0 when missing, when there are no slots, or when the stored index is outside the list. */
  getKeyCursor(workspaceId: string, provider: KeyProvider): Promise<number>;
  /** Stores the 0-based index of `keyId` in the current slot list. No-op when the id is absent. */
  setKeyCursor(workspaceId: string, provider: KeyProvider, keyId: string): Promise<void>;
  /** Writes the last test of one stored key. False when that id is not in the list (no write). */
  recordProviderKeyTest(
    workspaceId: string,
    provider: KeyProvider,
    keyId: string,
    status: KeyQuotaStatus,
    testedAt: Date,
  ): Promise<boolean>;

  /**
   * Throws WorkspaceDeletedError when the workspace is gone, so a late worker cannot write orphan rows.
   * A run with a jobId reuses that job's queued/running/failed run; completed and skipped runs are
   * never overwritten (a new run is created instead).
   */
  /**
   * Also throws ActiveRunExistsError when the new (or reused) run would be a second queued/running
   * run for the same workspace, repo, PR, head commit and bot slot (`botSlot` defaults to 1).
   */
  createReviewRun(run: NewReviewRun): Promise<ReviewRun>;
  /** Refreshes the heartbeat of a queued/running run; finished runs are left untouched. */
  touchReviewRun(workspaceId: string, id: string): Promise<void>;
  /**
   * Records the run's outcome. A finished status (completed/failed/skipped) also adds the run's
   * cost, tokens and status to the monthly usage of the month it was created in, in the same
   * transaction (every finish counts, so a retried run counts each attempt).
   */
  finishReviewRun(
    workspaceId: string,
    id: string,
    result: FinishReviewRunOptions,
  ): Promise<void>;
  getReviewRun(workspaceId: string, id: string): Promise<ReviewRun | null>;
  listReviewRuns(workspaceId: string, limit: number): Promise<ReviewRun[]>;
  listReviewRuns(workspaceId: string, options: ListReviewRunsOptions): Promise<ListReviewRunsResult>;
  listReviewRuns(
    workspaceId: string,
    limitOrOptions?: number | ListReviewRunsOptions,
  ): Promise<ReviewRun[] | ListReviewRunsResult>;
  listReviewRunRepos(workspaceId: string): Promise<string[]>;
  /**
   * Finds an active review run ('queued' or 'running') matching repo, PR and headSha, of the given
   * bot slot; with no slot, of any bot.
   */
  findActiveReviewRun(
    workspaceId: string,
    repoFullName: string,
    pullNumber: number,
    headSha: string,
    botSlot?: number,
  ): Promise<ReviewRun | null>;
  /**
   * For each (repo, PR), takes its latest run over all of the PR's runs; returns those latest runs
   * that are 'failed' and whose createdAt falls in [from, to]. Newest first, capped by
   * options.limit (default 25).
   */
  listLatestFailedRuns(workspaceId: string, options?: LatestFailedRunsOptions): Promise<ReviewRun[]>;
  /**
   * Fails queued/running runs whose heartbeat (updatedAt) is older than `heartbeatBefore`.
   * `onFailed`, when given, receives the failed runs' ids after the change is saved (ADR-0021).
   */
  failStaleRuns(heartbeatBefore: Date, onFailed?: (failed: readonly StaleRunRef[]) => void): Promise<number>;
  /**
   * Cost of the UTC month containing `monthStart` and every later month, from the monthly usage
   * summary (finished runs), so deleting runs never lowers it.
   */
  monthCostUsd(workspaceId: string, monthStart: Date): Promise<number>;
  /**
   * Deletes the workspace's credentials, settings, review runs and monthly usage and unlinks its
   * installations.
   * Postgres also deletes the Better Auth organization row (members and invitations cascade) in the
   * same transaction and reports `organizationDeleted: true`; a store without the auth tables
   * reports false and the caller deletes the organization itself.
   */
  deleteWorkspace(workspaceId: string): Promise<{ organizationDeleted: boolean }>;
}

/** Envelope encryption of customer secrets (ADR-0007). */
export interface Vault {
  readonly keyVersion: number;
  encrypt(plaintext: string, context: { workspaceId: string; provider: KeyProvider }): Promise<string>;
  decrypt(ciphertext: string, context: { workspaceId: string; provider: KeyProvider }): Promise<string>;
}

/** A run the stale sweep failed: just enough to say which row changed. */
export interface StaleRunRef {
  workspaceId: string;
  id: string;
}

export interface ReviewJob {
  deliveryId: string;
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  /** Asked for with `@mergepilot review`: every bot reviews the whole head, paused or not. */
  force?: boolean | undefined;
}

/**
 * A `@mergepilot pause|resume` PR comment (ADR-0012). The webhook only queues it; the worker checks
 * the commenter's write access and applies it, so the web process never writes to GitHub.
 */
export interface PauseCommandJob {
  kind: 'pause_command';
  deliveryId: string;
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  command: 'pause' | 'resume';
  commenterLogin: string;
  language: 'ar' | 'en';
}

/**
 * A `@mergepilot review` PR comment (ADR-0012 amendment): the worker checks the commenter's write
 * access and the PR, then runs a forced review of the current head.
 */
export interface ReviewCommandJob {
  kind: 'review_command';
  deliveryId: string;
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  command: 'review';
  commenterLogin: string;
  language: 'ar' | 'en';
}

export type CommandJob = PauseCommandJob | ReviewCommandJob;

export interface ReviewQueue {
  enqueue(job: ReviewJob): Promise<void>;
  /** Queues a PR comment command; optional so queues that cannot carry one leave it ignored. */
  enqueueCommand?(job: CommandJob): Promise<void>;
}

/** The authenticated caller of a dashboard request. */
export interface AuthContext {
  userId: string;
  email: string;
  workspaceId: string;
  role: Role;
}

export type { MergePilotConfig, ReviewModel, CredentialStore };

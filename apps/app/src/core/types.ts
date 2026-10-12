import type { MergePilotConfig, ReviewModel, CredentialStore, ApiProviderId, Severity } from '@mergepilot/engine';

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
 * Thrown by AppStore.createReviewRun when another run for the same workspace, repo, PR and head
 * commit is already `queued` or `running` (one active run per head; ADR-0009 amendment).
 */
export class ActiveRunExistsError extends Error {
  constructor(repoFullName: string, pullNumber: number) {
    super(`a review run for ${repoFullName}#${pullNumber} at this commit is already queued or running`);
    this.name = 'ActiveRunExistsError';
  }
}

/** Only these statuses count as active for the one-active-run-per-head rule. */
export const ACTIVE_RUN_STATUSES: readonly ReviewRunStatus[] = ['queued', 'running'];

export type ApiProvider = ApiProviderId;

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
}

export interface StoredCredential {
  id: string;
  workspaceId: string;
  provider: ApiProvider;
  /** Envelope-encrypted secret (see Vault). Never the plaintext. */
  ciphertext: string;
  keyVersion: number;
  /** Last 4 characters, for display only. */
  last4: string;
  createdBy: string;
  createdAt: Date;
  baseUrl?: string | null | undefined;
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
    | 'duration'
    | undefined;
  dir?: 'asc' | 'desc' | undefined;
}

export interface ListReviewRunsResult {
  runs: ReviewRun[];
  total: number;
}

/** Data access. Every workspace-owned read/write takes the workspaceId it is scoped to. */
export interface AppStore {
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
  getCredential(workspaceId: string, provider: ApiProvider): Promise<StoredCredential | null>;
  listCredentials(workspaceId: string): Promise<Array<Omit<StoredCredential, 'ciphertext'>>>;
  deleteCredential(workspaceId: string, provider: ApiProvider): Promise<void>;

  /**
   * Throws WorkspaceDeletedError when the workspace is gone, so a late worker cannot write orphan rows.
   * A run with a jobId reuses that job's queued/running/failed run; completed and skipped runs are
   * never overwritten (a new run is created instead).
   */
  /**
   * Also throws ActiveRunExistsError when the new (or reused) run would be a second queued/running
   * run for the same workspace, repo, PR and head commit.
   */
  createReviewRun(run: NewReviewRun): Promise<ReviewRun>;
  /** Refreshes the heartbeat of a queued/running run; finished runs are left untouched. */
  touchReviewRun(workspaceId: string, id: string): Promise<void>;
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
  /** Finds an active review run ('queued' or 'running') matching repo, PR, and headSha. */
  findActiveReviewRun(
    workspaceId: string,
    repoFullName: string,
    pullNumber: number,
    headSha: string,
  ): Promise<ReviewRun | null>;
  /**
   * For each (repo, PR), takes its latest run over all of the PR's runs; returns those latest runs
   * that are 'failed' and whose createdAt falls in [from, to]. Newest first, capped by
   * options.limit (default 25).
   */
  listLatestFailedRuns(workspaceId: string, options?: LatestFailedRunsOptions): Promise<ReviewRun[]>;
  /** Fails queued/running runs whose heartbeat (updatedAt) is older than `heartbeatBefore`. */
  failStaleRuns(heartbeatBefore: Date): Promise<number>;
  monthCostUsd(workspaceId: string, monthStart: Date): Promise<number>;
  /**
   * Deletes the workspace's credentials, settings and review runs and unlinks its installations.
   * Postgres also deletes the Better Auth organization row (members and invitations cascade) in the
   * same transaction and reports `organizationDeleted: true`; a store without the auth tables
   * reports false and the caller deletes the organization itself.
   */
  deleteWorkspace(workspaceId: string): Promise<{ organizationDeleted: boolean }>;
}

/** Envelope encryption of customer secrets (ADR-0007). */
export interface Vault {
  readonly keyVersion: number;
  encrypt(plaintext: string, context: { workspaceId: string; provider: ApiProvider }): Promise<string>;
  decrypt(ciphertext: string, context: { workspaceId: string; provider: ApiProvider }): Promise<string>;
}

export interface ReviewJob {
  deliveryId: string;
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
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

export interface ReviewQueue {
  enqueue(job: ReviewJob): Promise<void>;
  /** Queues a pause/resume command; optional so queues that cannot carry one leave it ignored. */
  enqueueCommand?(job: PauseCommandJob): Promise<void>;
}

/** The authenticated caller of a dashboard request. */
export interface AuthContext {
  userId: string;
  email: string;
  workspaceId: string;
  role: Role;
}

export type { MergePilotConfig, ReviewModel, CredentialStore };

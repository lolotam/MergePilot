import type { MergePilotConfig, ReviewModel, CredentialStore } from '@mergepilot/engine';

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

export type ApiProvider = 'anthropic' | 'openai' | 'gemini';

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
}

export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'skipped' | 'failed';

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

  /** Throws WorkspaceDeletedError when the workspace is gone, so a late worker cannot write orphan rows. */
  createReviewRun(run: Omit<ReviewRun, 'id' | 'createdAt' | 'finishedAt'>): Promise<ReviewRun>;
  finishReviewRun(
    workspaceId: string,
    id: string,
    result: { status: ReviewRunStatus; costUsd: number | null; detail: string | null },
  ): Promise<void>;
  listReviewRuns(workspaceId: string, limit: number): Promise<ReviewRun[]>;
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

export interface ReviewQueue {
  enqueue(job: ReviewJob): Promise<void>;
}

/** The authenticated caller of a dashboard request. */
export interface AuthContext {
  userId: string;
  email: string;
  workspaceId: string;
  role: Role;
}

export type { MergePilotConfig, ReviewModel, CredentialStore };

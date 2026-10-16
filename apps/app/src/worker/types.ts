import type {
  AppStore,
  KeyProvider,
  MergePilotConfig,
  ReviewModel,
  ReviewRunStatus,
} from '../core/types.js';
import type { GitHubClient } from '@mergepilot/github';
import type { FetchLike, Secret } from '@mergepilot/engine';
import type { DnsLookupFn } from '../core/ssrf.js';

export interface ProcessReviewCredentials {
  resolve(workspaceId: string, provider: KeyProvider): Promise<Secret>;
  getEffectiveAuthMethod?(workspaceId: string, provider: string): Promise<'subscription' | 'api-key' | null>;
  /**
   * Ordered keys for gemini, openrouter and opencode-zen (ADR-0026). Null when that provider
   * stores one credential. Optional so existing test fakes that only resolve one key still compile.
   */
  resolveKeyRoster?(
    workspaceId: string,
    provider: KeyProvider,
  ): Promise<{ secrets: Secret[]; keyIds: string[]; startIndex: number } | null>;
  /** Persists the cursor at the current position of this key id. Optional on the same test fakes. */
  rememberSuccessfulKey?(workspaceId: string, provider: KeyProvider, keyId: string): Promise<void>;
}

export type GitHubAppClientFactory = (installationId: number) => Promise<{
  client: GitHubClient;
  publisherLogin: string;
}>;

export interface ProcessReviewDeps {
  store: AppStore;
  credentials: ProcessReviewCredentials;
  githubAppFactory: GitHubAppClientFactory;
  createModelForProvider?: (
    config: MergePilotConfig,
    secret: Secret,
  ) => Promise<ReviewModel> | ReviewModel;
  log?: (message: string) => void;
  logger?: import('pino').Logger | undefined;
  now?: () => Date;
  /** Heartbeat interval while a review runs (default RUN_HEARTBEAT_INTERVAL_MS, 60 s). */
  heartbeatIntervalMs?: number | undefined;
  /** Test seams for the custom base URL SSRF guard (ADR-0010): DNS lookup and guarded fetch. */
  ssrfLookup?: DnsLookupFn | undefined;
  customFetch?: FetchLike | undefined;
  /** Test seam: the fetch the Jev judge uses (its endpoints are fixed preset URLs). */
  judgeFetch?: FetchLike | undefined;
  /** The app's public URL (`MERGEPILOT_BASE_URL`), for the bot logos in panel reviews (ADR-0017). */
  baseUrl?: string | undefined;
  /** Monthly-budget admission shared by the jobs of this worker (test seam; default: the process's). */
  budgetAdmission?: import('./budget-admission.js').BudgetAdmission | undefined;
}

export interface ProcessReviewResult {
  status: ReviewRunStatus;
  costUsd?: number | null;
  detail?: string | null;
}

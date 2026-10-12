import type {
  ApiProvider,
  AppStore,
  MergePilotConfig,
  ReviewModel,
  ReviewRunStatus,
} from '../core/types.js';
import type { GitHubClient } from '@mergepilot/github';
import type { FetchLike, Secret } from '@mergepilot/engine';
import type { DnsLookupFn } from '../core/ssrf.js';

export interface ProcessReviewCredentials {
  resolve(workspaceId: string, provider: ApiProvider): Promise<Secret>;
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
  now?: () => Date;
  /** Heartbeat interval while a review runs (default RUN_HEARTBEAT_INTERVAL_MS, 60 s). */
  heartbeatIntervalMs?: number | undefined;
  /** Test seams for the custom base URL SSRF guard (ADR-0010): DNS lookup and guarded fetch. */
  ssrfLookup?: DnsLookupFn | undefined;
  customFetch?: FetchLike | undefined;
}

export interface ProcessReviewResult {
  status: ReviewRunStatus;
  costUsd?: number | null;
  detail?: string | null;
}

import type {
  ApiProvider,
  AppStore,
  MergePilotConfig,
  ReviewModel,
  ReviewRunStatus,
} from '../core/types.js';
import type { GitHubClient } from '@mergepilot/github';
import type { Secret } from '@mergepilot/engine';

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
}

export interface ProcessReviewResult {
  status: ReviewRunStatus;
  costUsd?: number | null;
  detail?: string | null;
}

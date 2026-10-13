import type { Secret } from '@mergepilot/engine';
import type { GitHubClient, LoadRepoConfigResult, PullRequestFile } from '@mergepilot/github';
import type { Logger } from 'pino';
import type {
  ApiProvider,
  BotLogo,
  FallbackSetting,
  FinishReviewRunOptions,
  PanelMode,
  ReviewJob,
  ReviewRun,
  WorkspaceSettings,
} from '../core/types.js';
import type { BotConfig } from './bot-config.js';
import type { ReviewOnlyOutcome } from './bot-review-run.js';
import type { ModelChoice } from './model-choice.js';
import type { ProcessReviewDeps, ProcessReviewResult } from './types.js';

/** One bot of the reviewer panel (ADR-0017): slot 1 is the workspace settings, 2-5 extra bots. */
export interface PanelBot {
  slot: number;
  name: string;
  logo: BotLogo;
  provider: ApiProvider;
  model: string;
  effort: string | null;
  fallback: FallbackSetting[];
}

/** A bot whose run row is `running`, with its heartbeat. */
export interface BotRun {
  bot: PanelBot;
  run: ReviewRun;
  stopHeartbeat: () => void;
  /** `performance.now()` when the run started, for `panel.bot.done`. */
  startedAt: number;
}

/** What the shared steps produced; every bot reads it, none changes it. */
export interface PanelContext {
  job: ReviewJob;
  deps: ProcessReviewDeps;
  logger: Logger;
  workspaceId: string;
  settings: WorkspaceSettings;
  owner: string;
  repo: string;
  client: GitHubClient;
  publisherLogin: string;
  prTitle: string;
  prBody: string;
  repoConfigResult: LoadRepoConfigResult;
  /** Slot 1's model (the heavy-duty one for a large PR) and config. */
  mainChoice: ModelChoice;
  mainConfig: BotConfig;
  /** True when at least one extra bot is active: the panel's own behaviour applies. */
  panelActive: boolean;
  mode: PanelMode;
  /** The PR's files, listed once when the panel is active. */
  prFiles?: PullRequestFile[] | undefined;
  /** The app's public URL, for the bot logos. */
  baseUrl?: string | undefined;
  /** `performance.now()` when the job started, for `job.end`. */
  startTime: number;
}

/** A bot's review in consensus mode, run but not yet published or recorded. */
export interface PendingBot {
  outcome: ReviewOnlyOutcome;
  finish: FinishReviewRunOptions;
  /** `provider:model` of the model that answered. */
  modelLabel: string;
  knownSecrets: Secret[];
}

export interface BotOutcome {
  slot: number;
  /** The bot's result, as the job would return it for slot 1. */
  result: ProcessReviewResult;
  /** Findings the bot recorded (0 when it did not complete). */
  findings?: number | undefined;
  /** Set in consensus mode when the bot reviewed (its run is finished after publishing). */
  pending?: PendingBot | undefined;
}

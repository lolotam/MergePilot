import {
  parseConfig,
  redactSecrets,
  runReview,
  type Finding,
  type MergePilotConfig,
  type ReviewModel,
  type Secret,
} from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import { readFilesAtRef, type FileContent } from './contents.js';
import { listPullRequestFiles } from './pr-files.js';
import { publishReview, type PublishReviewResult } from './publish.js';
import { renderReviewSummary } from './summary.js';

export type LoadRepoConfigResult =
  | { configText: string; config: MergePilotConfig; rulesFiles: FileContent[] }
  | { missing: true }
  | { errors: string[] };

/**
 * Loads and parses .mergepilot.yml and its referenced rulesFiles from the base branch.
 */
export async function loadRepoConfig(
  client: GitHubClient,
  params: { owner: string; repo: string; baseSha: string },
): Promise<LoadRepoConfigResult> {
  const configFiles = await readFilesAtRef(client, {
    owner: params.owner,
    repo: params.repo,
    ref: params.baseSha,
    paths: ['.mergepilot.yml'],
  });

  const configFile = configFiles[0];
  if (!configFile) {
    return { missing: true };
  }

  const parseResult = parseConfig(configFile.content);
  if (!parseResult.ok) {
    return { errors: parseResult.errors };
  }

  const config = parseResult.config;
  const rulesFiles = await readFilesAtRef(client, {
    owner: params.owner,
    repo: params.repo,
    ref: params.baseSha,
    paths: config.review.rulesFiles,
  });

  return {
    configText: configFile.content,
    config,
    rulesFiles,
  };
}

export interface ReviewPullRequestContext {
  client: GitHubClient;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  prTitle: string;
  prBody: string;
  config: MergePilotConfig;
  configHash: string;
  rulesFiles: FileContent[];
  model: ReviewModel;
  knownSecrets?: Secret[] | undefined;
  publisherLogin?: string | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface ReviewPullRequestResult {
  outcome: 'completed' | 'skipped-budget' | 'failed';
  costUsd?: number | undefined;
  detail?: string | undefined;
  publish: PublishReviewResult;
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

/**
 * Executes a pull request review and publishes the result to GitHub.
 * Shell-agnostic core shared between the GitHub Action and SaaS worker.
 */
export async function reviewPullRequest(
  ctx: ReviewPullRequestContext,
): Promise<ReviewPullRequestResult> {
  const {
    client,
    owner,
    repo,
    pullNumber,
    headSha,
    prTitle,
    prBody,
    config,
    configHash,
    rulesFiles,
    model,
    knownSecrets = [],
    publisherLogin = 'github-actions[bot]',
    log,
  } = ctx;

  log?.(`Listing files for pull request #${pullNumber}...`);
  const { files: prFiles } = await listPullRequestFiles(client, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  log?.(`Found ${prFiles.length} files in PR diff`);

  log?.('Running review...');
  const reviewResult = await runReview({
    config,
    pr: {
      title: prTitle,
      body: prBody,
    },
    files: prFiles,
    rulesFiles,
    model,
    knownSecrets,
  });
  log?.(`Review completed with status: ${reviewResult.status}`);

  // ADR-0008: when an explicit fallback model answered, the summary names it and says why.
  const fallbackSummary =
    reviewResult.status !== 'skipped-budget' && reviewResult.fallbackFrom && reviewResult.fallbackCode
      ? {
          modelLabel: reviewResult.modelUsed ?? model.label,
          fallback: { from: reviewResult.fallbackFrom, code: reviewResult.fallbackCode },
        }
      : {};

  const envVar = PROVIDER_ENV_MAP[config.provider] ?? 'API key';
  let summaryMarkdown: string;
  let inlineFindings: Finding[];
  let outcome: 'completed' | 'skipped-budget' | 'failed';
  let costUsd: number | undefined;
  let detail: string | undefined;

  if (reviewResult.status === 'completed') {
    outcome = 'completed';
    costUsd = reviewResult.costUsd;
    inlineFindings = reviewResult.inline;
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: reviewResult.summary,
      summaryOnly: reviewResult.summaryOnly,
      inlineCount: reviewResult.inline.length,
      complete: reviewResult.complete,
      incompleteReasons: reviewResult.result.incompleteReasons,
      modelLabel: model.label,
      ...fallbackSummary,
      outcome: 'completed',
      ...(reviewResult.costUsd !== undefined ? { costUsd: reviewResult.costUsd } : {}),
      ...(reviewResult.usage?.inputTokens !== undefined
        ? { inputTokens: reviewResult.usage.inputTokens }
        : {}),
      ...(reviewResult.usage?.outputTokens !== undefined
        ? { outputTokens: reviewResult.usage.outputTokens }
        : {}),
    });
  } else if (reviewResult.status === 'skipped-budget') {
    outcome = 'skipped-budget';
    detail = reviewResult.reason;
    inlineFindings = [];
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: '',
      summaryOnly: [],
      inlineCount: 0,
      complete: false,
      incompleteReasons: [reviewResult.reason],
      modelLabel: model.label,
      outcome: 'skipped-budget',
      reason: reviewResult.reason,
    });
  } else {
    outcome = 'failed';
    inlineFindings = [];
    let reason: string;
    if (reviewResult.reason === 'INVALID_CREDENTIAL') {
      reason = `Review failed: invalid credential for provider "${config.provider}". Please check the ${envVar} secret.`;
    } else if (reviewResult.reason === 'QUOTA') {
      reason = `Review failed: quota exceeded for provider "${config.provider}". Please check quota and billing for ${envVar}.`;
    } else {
      reason = `Review failed: ${reviewResult.reason}`;
    }
    if (reviewResult.detail) {
      log?.(`Provider error detail: ${redactSecrets(reviewResult.detail, knownSecrets).text}`);
      reason += ` — ${reviewResult.detail}`;
    }
    reason = redactSecrets(reason, knownSecrets).text;
    detail = redactSecrets(reviewResult.detail ?? reviewResult.reason, knownSecrets).text;
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: '',
      summaryOnly: [],
      inlineCount: 0,
      complete: false,
      incompleteReasons: [reason],
      modelLabel: model.label,
      ...fallbackSummary,
      outcome: 'failed',
      reason,
    });
  }

  log?.(`Publishing review as ${publisherLogin}...`);
  const publish = await publishReview(client, {
    owner,
    repo,
    pull_number: pullNumber,
    expectedHeadSha: headSha,
    summaryMarkdown,
    inline: inlineFindings,
    configHash,
    language: config.language,
    suggestionsAsCode: false,
    publisherLogin,
  });
  log?.(`Review publication outcome: ${publish.status}`);

  return {
    outcome,
    costUsd,
    detail,
    publish,
  };
}

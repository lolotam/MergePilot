import {
  parseConfig,
  redactSecrets,
  runReview,
  type Finding,
  type DefaultedKey,
  type MergePilotConfig,
  type ParseConfigOptions,
  type ReviewModel,
  type Secret,
} from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import { readFilesAtRef, type FileContent } from './contents.js';
import { deduplicateFindings } from './dedupe.js';
import {
  hasNothingNewToReview,
  NOTHING_NEW_DETAIL,
  reviewScopeOf,
  selectIncrementalFiles,
} from './incremental.js';
import { fallbackReasonOf } from './fallback-reason.js';
import { dedupeJudgeOf, judgeSummaryInput, withJudgeUsage, type ReviewJudge } from './judge-summary.js';
import { isPrPaused, postPauseNoticeOnce } from './pause.js';
import { listPullRequestFiles } from './pr-files.js';
import { publishReview, type PublishReviewResult } from './publish.js';
import { contextDisclosureOf } from './review-context.js';
import { gatherReviewInputs } from './review-inputs.js';
import { renderReviewSummary } from './summary.js';

export type LoadRepoConfigResult =
  | {
      configText: string;
      config: MergePilotConfig;
      rulesFiles: FileContent[];
      /** Keys the file left out and `defaults` filled: the file did not name them. */
      defaulted?: DefaultedKey[];
    }
  | { missing: true }
  | { errors: string[] };

/**
 * Loads and parses .mergepilot.yml and its referenced rulesFiles from the base branch.
 * `defaults` fills a file without `provider` (the SaaS App, which picks the provider and model itself).
 */
export async function loadRepoConfig(
  client: GitHubClient,
  params: { owner: string; repo: string; baseSha: string; defaults?: ParseConfigOptions['defaults'] },
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

  const parseResult = parseConfig(configFile.content, { defaults: params.defaults });
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
    ...(parseResult.defaulted ? { defaulted: parseResult.defaulted } : {}),
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
  /** Optional Jev judge (ADR-0015): false-positive filter and semantic duplicate check. */
  judge?: ReviewJudge | undefined;
}

export interface ReviewPullRequestResult {
  outcome: 'completed' | 'skipped' | 'skipped-budget' | 'failed';
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
    baseSha,
    prTitle,
    prBody,
    config,
    configHash,
    rulesFiles,
    model,
    knownSecrets = [],
    publisherLogin = 'github-actions[bot]',
    log,
    judge,
  } = ctx;

  // 1. Check pause state before running review or calling model
  const pr = await client.getPullRequest({ owner, repo, pull_number: pullNumber });
  const prLabels = pr.labels?.map((l) => l.name) ?? [];
  const paused = await isPrPaused(client, {
    owner,
    repo,
    pull_number: pullNumber,
    publisherLogin,
    labels: prLabels,
  });

  if (paused) {
    log?.('MergePilot skipped: automatic reviews are paused on this PR');
    await postPauseNoticeOnce(client, {
      owner,
      repo,
      pull_number: pullNumber,
      publisherLogin,
      language: config.language,
    });
    return {
      outcome: 'skipped',
      detail: 'automatic reviews are paused on this PR',
      publish: { status: 'skipped-paused' },
    };
  }

  log?.(`Listing files for pull request #${pullNumber}...`);
  const { files: prFiles } = await listPullRequestFiles(client, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  log?.(`Found ${prFiles.length} files in PR diff`);

  const selection = await selectIncrementalFiles(client, {
    owner,
    repo,
    pull_number: pullNumber,
    headSha,
    publisherLogin,
    prFiles,
    configHash,
    baseSha,
  });

  const filesToReview = selection.files;
  log?.(
    selection.mode === 'incremental'
      ? `Incremental review: ${filesToReview.length} files changed since ${selection.sinceSha.slice(0, 7)}`
      : `Full review: ${selection.reason}`,
  );
  if (hasNothingNewToReview(selection)) {
    log?.(`MergePilot skipped: ${NOTHING_NEW_DETAIL}`);
    return { outcome: 'skipped', detail: NOTHING_NEW_DETAIL, publish: { status: 'skipped-no-changes' } };
  }

  // Nested owner rules at the base commit (ADR-0028), repository context at the head (ADR-0029);
  // an incremental run also sees the rest of the PR and its open findings (ADR-0030).
  const followUp =
    selection.mode === 'incremental'
      ? { sinceSha: selection.sinceSha, prFiles, pullNumber, publisherLogin }
      : undefined;
  const inputs = await gatherReviewInputs(client, { owner, repo, baseSha, headSha, config, rulesFiles, files: filesToReview, prBody, followUp, log });

  log?.('Running review...');
  const reviewResult = await runReview({
    config,
    pr: {
      title: prTitle,
      body: prBody,
    },
    files: filesToReview,
    anchorFiles: prFiles,
    rulesFiles: inputs.rulesFiles,
    contextFiles: inputs.contextFiles,
    followUp: inputs.followUp,
    model,
    knownSecrets,
    judge,
  });
  log?.(`Review completed with status: ${reviewResult.status}`);

  // ADR-0008: when an explicit fallback model answered, the summary names it and says why.
  const disclosure = reviewResult.status === 'skipped-budget' ? undefined : reviewResult;
  const fallback = disclosure ? fallbackReasonOf(disclosure, knownSecrets) : undefined;
  const fallbackSummary = fallback ? { modelLabel: disclosure?.modelUsed ?? model.label, fallback } : {};

  const scope = reviewScopeOf(selection);

  const envVar = PROVIDER_ENV_MAP[config.provider] ?? 'API key';
  let summaryMarkdown: string;
  let inlineFindings: Finding[];
  let outcome: 'completed' | 'skipped-budget' | 'failed';
  let costUsd: number | undefined;
  let detail: string | undefined;

  if (reviewResult.status === 'completed') {
    outcome = 'completed';

    const deduped = await deduplicateFindings(client, {
      owner,
      repo,
      pull_number: pullNumber,
      publisherLogin,
      findings: reviewResult.inline,
      judge: dedupeJudgeOf(judge),
      knownSecrets,
      maxUsd: judgeBudgetLeft(config, reviewResult.costUsd, judge),
    });
    inlineFindings = deduped.kept;
    if (deduped.skipped) {
      log?.('Could not read existing review comments; publishing without duplicate filtering');
    }
    if (deduped.dropped.length > 0) {
      log?.(`Dropped ${deduped.dropped.length} duplicate findings already commented on this PR`);
    }
    const judgeReport = judge?.judge.report();
    const totals = withJudgeUsage(reviewResult.costUsd, reviewResult.usage, judgeReport);
    costUsd = totals.costUsd;

    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: reviewResult.summary,
      summaryOnly: reviewResult.summaryOnly,
      inlineCount: inlineFindings.length,
      complete: reviewResult.complete,
      incompleteReasons: reviewResult.result.incompleteReasons,
      modelLabel: model.label,
      ...fallbackSummary,
      scope,
      outcome: 'completed',
      judge: judgeSummaryInput(judgeReport, reviewResult.judge, judge?.uses),
      verifyRejected: reviewResult.verifyRejected,
      withheld: reviewResult.withheld,
      rulesLeftOut: inputs.rulesLeftOut,
      context: contextDisclosureOf(reviewResult.context, inputs.contextLeftOut, inputs.openFindings),
      outputLimit: reviewResult.outputLimit,
      ...(totals.costUsd !== undefined ? { costUsd: totals.costUsd } : {}),
      ...(totals.inputTokens !== undefined ? { inputTokens: totals.inputTokens } : {}),
      ...(totals.outputTokens !== undefined ? { outputTokens: totals.outputTokens } : {}),
    });
  } else if (reviewResult.status === 'skipped-budget') {
    outcome = 'skipped-budget';
    detail = redactSecrets(reviewResult.reason, knownSecrets).text;
    log?.(`MergePilot skipped this review for its budget: ${detail}`);
    inlineFindings = [];
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: '',
      summaryOnly: [],
      inlineCount: 0,
      complete: false,
      incompleteReasons: [reviewResult.reason],
      modelLabel: model.label,
      scope,
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
      scope,
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
    // Partial unless every reviewable file was covered (no failed batch, no file dropped for budget).
    partial: !(outcome === 'completed' && reviewResult.status === 'completed' && reviewResult.complete),
    alreadyDeduplicated: true,
  });
  log?.(`Review publication outcome: ${publish.status}`);

  return {
    outcome,
    costUsd,
    detail,
    publish,
  };
}

/** The per-review budget left for a judge call after the review (and earlier judge calls). */
export function judgeBudgetLeft(config: MergePilotConfig, reviewCostUsd: number | undefined, judge: ReviewJudge | undefined): number {
  const spent = (reviewCostUsd ?? 0) + (judge?.judge.report().costUsd ?? 0);
  return Math.max(0, config.budget.perReviewUsd - spent);
}

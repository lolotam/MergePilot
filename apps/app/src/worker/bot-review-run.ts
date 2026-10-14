import {
  redactSecrets,
  runReview,
  type MergePilotConfig,
  type ReviewModel,
  type ReviewRunResult,
  type Secret,
} from '@mergepilot/engine';
import {
  fallbackReasonOf,
  hasNothingNewToReview,
  listPullRequestFiles,
  NOTHING_NEW_DETAIL,
  reviewScopeOf,
  selectIncrementalFiles,
  withJudgeUsage,
  type FallbackReason,
  type FileContent,
  type GitHubClient,
  type PullRequestFile,
  type ReviewJudge,
  type ReviewScope,
  type SelectIncrementalFilesResult,
} from '@mergepilot/github';

/** What one bot needs to review a PR head (ADR-0017: every bot of the panel runs this). */
export interface BotReviewParams {
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
  /** The reviewer-panel bot (ADR-0017), default 1: its own earlier reviews are the incremental base. */
  botSlot?: number | undefined;
  /** The PR's files, when the caller already listed them (the panel lists them once). */
  prFiles?: PullRequestFile[] | undefined;
  /**
   * The file selection, when the caller already made it (consensus: slot 1's, for every bot);
   * used only together with `prFiles`.
   */
  selection?: SelectIncrementalFilesResult | undefined;
  /** `@mergepilot review`: the whole PR, published even when this head was already reviewed. */
  force?: boolean | undefined;
}

export type BotReviewRun =
  | { kind: 'nothing-new' }
  | { kind: 'reviewed'; reviewResult: ReviewRunResult; scope: ReviewScope };

export const DEFAULT_PUBLISHER_LOGIN = 'github-actions[bot]';

export interface BotFiles {
  /** Every file of the PR diff: the anchors for inline comments. */
  prFiles: PullRequestFile[];
  /** What the bot reviews: everything, or what changed since its last review. */
  selection: SelectIncrementalFilesResult;
}

/** The PR files a bot reviews: listed (unless given), then narrowed since its last review. */
export async function selectBotFiles(
  params: Pick<BotReviewParams, 'client' | 'owner' | 'repo' | 'pullNumber' | 'headSha' | 'baseSha' | 'configHash' | 'publisherLogin' | 'log' | 'botSlot' | 'prFiles' | 'force'>,
): Promise<BotFiles> {
  const { client, owner, repo, pullNumber, headSha, configHash, log, botSlot } = params;
  let prFiles = params.prFiles;
  if (!prFiles) {
    log?.(`Listing files for pull request #${pullNumber}...`);
    prFiles = (await listPullRequestFiles(client, { owner, repo, pull_number: pullNumber })).files;
    log?.(`Found ${prFiles.length} files in PR diff`);
  }
  log?.('Selecting files for review (incremental check)...');
  const selection = await selectIncrementalFiles(client, {
    owner,
    repo,
    pull_number: pullNumber,
    headSha,
    prFiles,
    publisherLogin: params.publisherLogin ?? DEFAULT_PUBLISHER_LOGIN,
    configHash,
    baseSha: params.baseSha,
    ...(botSlot !== undefined ? { botSlot } : {}),
    ...(params.force ? { force: true } : {}),
  });
  return { prFiles, selection };
}

/** Lists and selects the files (unless given), then runs the model; never publishes. */
export async function runBotReview(params: BotReviewParams): Promise<BotReviewRun> {
  const { config, model, rulesFiles, knownSecrets = [], log, judge } = params;
  const { prFiles, selection: incremental } =
    params.selection && params.prFiles
      ? { prFiles: params.prFiles, selection: params.selection }
      : await selectBotFiles(params);
  const filesToReview = incremental.files;
  const scope = reviewScopeOf(incremental);
  log?.(`Review scope: ${scope.mode} (${filesToReview.length} files)`);
  if (hasNothingNewToReview(incremental)) {
    log?.(`Review skipped: ${NOTHING_NEW_DETAIL}`);
    return { kind: 'nothing-new' };
  }

  log?.('Running review...');
  const reviewResult = await runReview({
    config,
    pr: { title: params.prTitle, body: params.prBody },
    files: filesToReview,
    anchorFiles: prFiles,
    rulesFiles,
    model,
    knownSecrets,
    judge,
  });
  log?.(`Review completed with status: ${reviewResult.status}`);
  return { kind: 'reviewed', reviewResult, scope };
}

/** The outcome of a bot's review that is not published by itself (consensus mode). */
export interface ReviewOnlyOutcome {
  outcome: 'completed' | 'skipped' | 'skipped-budget' | 'failed';
  costUsd?: number | undefined;
  detail?: string | undefined;
  runResult?: ReviewRunResult | undefined;
  modelUsed?: string | undefined;
  fallbackFrom?: string | undefined;
  /** Why a fallback model took over: the provider's answer, redacted and cut (ADR-0008). */
  fallback?: FallbackReason | undefined;
  scope?: ReviewScope | undefined;
}

/** Status, cost (with the judge's) and a redacted detail, as `executeReview` records them. */
export function reviewOnlyOutcome(run: BotReviewRun, params: Pick<BotReviewParams, 'knownSecrets' | 'judge'>): ReviewOnlyOutcome {
  if (run.kind === 'nothing-new') return { outcome: 'skipped', detail: NOTHING_NEW_DETAIL };
  const secrets = params.knownSecrets ?? [];
  const r = run.reviewResult;
  const base = { runResult: r, scope: run.scope };
  if (r.status === 'completed') {
    const totals = withJudgeUsage(r.costUsd, r.usage, params.judge?.judge.report());
    return {
      ...base,
      outcome: 'completed',
      costUsd: totals.costUsd,
      ...(r.modelUsed ? { modelUsed: r.modelUsed } : {}),
      ...(r.fallbackFrom ? { fallbackFrom: r.fallbackFrom } : {}),
      ...withFallback(r, secrets),
    };
  }
  if (r.status === 'skipped-budget') {
    return { ...base, outcome: 'skipped-budget', detail: redactSecrets(r.reason, secrets).text };
  }
  return {
    ...base,
    outcome: 'failed',
    detail: redactSecrets(r.detail ?? r.reason, secrets).text,
    ...(r.modelUsed ? { modelUsed: r.modelUsed } : {}),
    ...(r.fallbackFrom ? { fallbackFrom: r.fallbackFrom } : {}),
    ...withFallback(r, secrets),
  };
}

function withFallback(r: Parameters<typeof fallbackReasonOf>[0], secrets: Secret[]): { fallback?: FallbackReason } {
  const fallback = fallbackReasonOf(r, secrets);
  return fallback ? { fallback } : {};
}

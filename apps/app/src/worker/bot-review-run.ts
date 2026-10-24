import {
  redactSecrets,
  runReview,
  type ContextDisclosure,
  type MergePilotConfig,
  type ReviewModel,
  type ReviewRunResult,
  type ReviewSkill,
  type Secret,
} from '@mergepilot/engine';
import {
  contextDisclosureOf,
  fallbackReasonOf,
  gatherReviewInputs,
  hasNothingNewToReview,
  listPullRequestFiles,
  NOTHING_NEW_DETAIL,
  rebuildMissingPatches,
  reviewScopeOf,
  selectIncrementalFiles,
  withJudgeUsage,
  type FallbackReason,
  type FileContent,
  type FollowUpParams,
  type GitHubClient,
  type PullRequestFile,
  type ReviewJudge,
  type ReviewScope,
  type SelectIncrementalFilesResult,
} from '@mergepilot/github';
import { MAIN_BOT_SLOT } from '../core/types.js';

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
  /** The bot's review skill (ADR-0034): added on top of the core review prompt. */
  skill?: ReviewSkill | undefined;
}

export type BotReviewRun =
  | { kind: 'nothing-new' }
  /**
   * `rulesLeftOut`: nested rules files the review could not include (ADR-0028); `context`: the
   * repository context sent and left out (ADR-0029). Both for the summary.
   */
  | {
      kind: 'reviewed';
      reviewResult: ReviewRunResult;
      scope: ReviewScope;
      rulesLeftOut: string[];
      context?: ContextDisclosure | undefined;
    };

export const DEFAULT_PUBLISHER_LOGIN = 'github-actions[bot]';

export interface BotFiles {
  /** Every file of the PR diff: the anchors for inline comments. */
  prFiles: PullRequestFile[];
  /** What the bot reviews: everything, or what changed since its last review. */
  selection: SelectIncrementalFilesResult;
}

/** The PR files a bot reviews: listed (unless given), then narrowed since its last review. */
export async function selectBotFiles(
  params: Pick<BotReviewParams, 'client' | 'owner' | 'repo' | 'pullNumber' | 'headSha' | 'baseSha' | 'configHash' | 'publisherLogin' | 'log' | 'botSlot' | 'prFiles' | 'force'> & {
    /** The paths the review excludes: their content is never read to rebuild a patch. */
    exclude?: string[];
  },
): Promise<BotFiles> {
  const { client, owner, repo, pullNumber, headSha, configHash, log, botSlot } = params;
  let prFiles = params.prFiles;
  if (!prFiles) {
    log?.(`Listing files for pull request #${pullNumber}...`);
    const listed = await listPullRequestFiles(client, { owner, repo, pull_number: pullNumber });
    // A file whose diff is too big for GitHub's files API comes without a patch (ADR-0045): its
    // patch is rebuilt from the file contents, so the bots see the file at all.
    const rebuilt = await rebuildMissingPatches(client, listed.files, {
      owner,
      repo,
      baseSha: params.baseSha,
      headSha: params.headSha,
      ...(params.exclude ? { exclude: params.exclude } : {}),
    });
    prFiles = rebuilt.files;
    log?.(`Found ${prFiles.length} files in PR diff`);
    if (rebuilt.rebuilt.length > 0 || rebuilt.failed.length > 0) {
      log?.(`Rebuilt ${rebuilt.rebuilt.length} missing patches, failed ${rebuilt.failed.length}`);
      if (rebuilt.failed.length > 0) {
        log?.(`Patches not rebuilt: ${rebuilt.failed.map((f) => `${f.path} (${f.reason})`).join(', ')}`);
      }
    }
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
      : await selectBotFiles({ ...params, exclude: params.config.review.exclude });
  const filesToReview = incremental.files;
  const scope = reviewScopeOf(incremental);
  log?.(`Review scope: ${scope.mode} (${filesToReview.length} files)`);
  if (hasNothingNewToReview(incremental)) {
    log?.(`Review skipped: ${NOTHING_NEW_DETAIL}`);
    return { kind: 'nothing-new' };
  }

  // Nested owner rules at the base commit (ADR-0028), repository context at the head (ADR-0029)
  // and, on an incremental run, the rest of the PR and the open findings (ADR-0030); reads are
  // cached per client, so the bots of one panel share them.
  const inputs = await gatherReviewInputs(params.client, {
    owner: params.owner,
    repo: params.repo,
    baseSha: params.baseSha,
    headSha: params.headSha,
    config,
    rulesFiles,
    files: filesToReview,
    prBody: params.prBody,
    followUp: followUpOf(params, incremental, prFiles),
    log,
  });

  log?.('Running review...');
  const reviewResult = await runReview({
    config,
    pr: { title: params.prTitle, body: params.prBody },
    files: filesToReview,
    anchorFiles: prFiles,
    rulesFiles: inputs.rulesFiles,
    contextFiles: inputs.contextFiles,
    followUp: inputs.followUp,
    model,
    knownSecrets,
    judge,
    ...(params.skill ? { skill: params.skill } : {}),
  });
  log?.(`Review completed with status: ${reviewResult.status}`);
  const context = contextDisclosureOf(
    reviewResult.status === 'completed' ? reviewResult.context : undefined,
    inputs.contextLeftOut,
    inputs.openFindings,
  );
  return { kind: 'reviewed', reviewResult, scope, rulesLeftOut: inputs.rulesLeftOut, ...(context ? { context } : {}) };
}

/**
 * The follow-up of an incremental run (ADR-0030). Its open findings are those of the slot whose
 * reviews were the incremental base: slot 1's when the caller made the selection (a consensus
 * panel publishes as slot 1), else this bot's own.
 */
function followUpOf(
  params: BotReviewParams,
  selection: SelectIncrementalFilesResult,
  prFiles: PullRequestFile[],
): FollowUpParams | undefined {
  if (selection.mode !== 'incremental') return undefined;
  const callerSelected = params.selection !== undefined && params.prFiles !== undefined;
  return {
    sinceSha: selection.sinceSha,
    prFiles,
    pullNumber: params.pullNumber,
    publisherLogin: params.publisherLogin ?? DEFAULT_PUBLISHER_LOGIN,
    botSlot: callerSelected ? MAIN_BOT_SLOT : params.botSlot,
  };
}

/** The outcome of a bot's review that is not published by itself (consensus mode). */
export interface ReviewOnlyOutcome {
  outcome: 'completed' | 'skipped' | 'skipped-budget' | 'failed';
  costUsd?: number | undefined;
  detail?: string | undefined;
  runResult?: ReviewRunResult | undefined;
  modelUsed?: string | undefined;
  fallbackFrom?: string | undefined;
  fallbackFromMethod?: 'subscription' | 'api-key' | undefined;
  modelUsedMethod?: 'subscription' | 'api-key' | undefined;
  /** Why a fallback model took over: the provider's answer, redacted and cut (ADR-0008). */
  fallback?: FallbackReason | undefined;
  scope?: ReviewScope | undefined;
  /** Nested rules files the review could not include (ADR-0028). */
  rulesLeftOut?: string[] | undefined;
  /** Repository context sent and left out (ADR-0029). */
  context?: ContextDisclosure | undefined;
}

/** Status, cost (with the judge's) and a redacted detail, as `executeReview` records them. */
export function reviewOnlyOutcome(run: BotReviewRun, params: Pick<BotReviewParams, 'knownSecrets' | 'judge'>): ReviewOnlyOutcome {
  if (run.kind === 'nothing-new') return { outcome: 'skipped', detail: NOTHING_NEW_DETAIL };
  const secrets = params.knownSecrets ?? [];
  const r = run.reviewResult;
  const base = { runResult: r, scope: run.scope, rulesLeftOut: run.rulesLeftOut, context: run.context };
  if (r.status === 'completed') {
    const totals = withJudgeUsage(r.costUsd, r.usage, params.judge?.judge.report());
    return {
      ...base,
      outcome: 'completed',
      costUsd: totals.costUsd,
      ...(r.modelUsed ? { modelUsed: r.modelUsed } : {}),
      ...(r.fallbackFrom ? { fallbackFrom: r.fallbackFrom } : {}),
      ...(r.fallbackFromMethod ? { fallbackFromMethod: r.fallbackFromMethod } : {}),
      ...(r.modelUsedMethod ? { modelUsedMethod: r.modelUsedMethod } : {}),
      ...withFallback(r, secrets),
    };
  }
  if (r.status === 'skipped-budget') {
    return { ...base, outcome: 'skipped-budget', detail: redactSecrets(r.reason, secrets).text };
  }
  return {
    ...base,
    outcome: 'failed',
    // What the calls before the failure cost; the judge never ran (ADR-0027 amendment).
    costUsd: r.costUsd,
    detail: redactSecrets(r.detail ?? r.reason, secrets).text,
    ...(r.modelUsed ? { modelUsed: r.modelUsed } : {}),
    ...(r.fallbackFrom ? { fallbackFrom: r.fallbackFrom } : {}),
    ...(r.fallbackFromMethod ? { fallbackFromMethod: r.fallbackFromMethod } : {}),
    ...(r.modelUsedMethod ? { modelUsedMethod: r.modelUsedMethod } : {}),
    ...withFallback(r, secrets),
  };
}

function withFallback(r: Parameters<typeof fallbackReasonOf>[0], secrets: Secret[]): { fallback?: FallbackReason } {
  const fallback = fallbackReasonOf(r, secrets);
  return fallback ? { fallback } : {};
}

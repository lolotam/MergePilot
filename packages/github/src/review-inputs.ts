import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_PR_CONTEXT_TOKENS,
  type ContextDisclosure,
  type FollowUp,
  type MergePilotConfig,
  type RepositoryContextFile,
} from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import type { FileContent } from './contents.js';
import { gatherOpenFindings } from './open-findings.js';
import { pullRequestContextFiles } from './pr-context.js';
import { gatherRepositoryContext, type ReviewedFile } from './review-context.js';
import { withNestedRulesFiles } from './rules-files.js';

/** What an incremental run adds to make the review a follow-up of the last one (ADR-0030). */
export interface FollowUpParams {
  /** The head the previous review covered. */
  sinceSha: string;
  /** Every file of the PR diff (base...head), with its PR patch. */
  prFiles: readonly ReviewedFile[];
  pullNumber: number;
  publisherLogin: string;
  /** The panel slot whose reviews were the incremental base: its open findings are shown. */
  botSlot?: number | undefined;
}

export interface ReviewInputsParams {
  owner: string;
  repo: string;
  /** Owner rules are read here (ADR-0028). */
  baseSha: string;
  /** Repository context is read here (ADR-0029). */
  headSha: string;
  config: MergePilotConfig;
  /** The configured rules files, already read from the base commit. */
  rulesFiles: FileContent[];
  /** The files this review covers. */
  files: readonly ReviewedFile[];
  /** Set on an incremental run only: the rest of the PR and the open findings (ADR-0030). */
  followUp?: FollowUpParams | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface ReviewInputs {
  rulesFiles: FileContent[];
  /** Nested rules files left out (ADR-0028), for the summary. */
  rulesLeftOut: string[];
  /** Repository context for `runReview` (ADR-0029), plus the PR's other files on a follow-up (ADR-0030). */
  contextFiles: RepositoryContextFile[];
  /** Context files the gatherer could not include, for the summary. */
  contextLeftOut: string[];
  /** For `runReview` on an incremental run (ADR-0030). */
  followUp?: FollowUp | undefined;
  /** The open findings shown, for the summary (ADR-0030). */
  openFindings?: ContextDisclosure['openFindings'];
}

/** The head content of the reviewed files that repository context already read. */
function headContentOf(files: readonly RepositoryContextFile[]): Map<string, string> {
  return new Map(files.filter((f) => f.kind === 'changed-file').map((f) => [f.path, f.content]));
}

/**
 * What a review reads from the repository besides the diff, shared by the Action and every App
 * bot: the nearest nested owner rules (base commit), the repository context (head commit) and, on
 * an incremental run, the rest of the pull request and the bot's open findings. Reads are cached
 * per client, so the bots of one panel read each file once.
 */
export async function gatherReviewInputs(client: GitHubClient, params: ReviewInputsParams): Promise<ReviewInputs> {
  const { owner, repo, config, log, followUp } = params;
  const contextTokens = config.review.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const [rules, context, open] = await Promise.all([
    withNestedRulesFiles(client, {
      owner,
      repo,
      baseSha: params.baseSha,
      rulesFiles: params.rulesFiles,
      changedPaths: params.files.map((f) => f.path),
      maxRulesTokens: config.review.maxRulesTokens,
    }),
    gatherRepositoryContext(client, {
      owner,
      repo,
      headSha: params.headSha,
      files: params.files,
      exclude: config.review.exclude,
      contextTokens,
    }),
    followUp
      ? gatherOpenFindings(client, {
          owner,
          repo,
          pull_number: followUp.pullNumber,
          publisherLogin: followUp.publisherLogin,
          botSlot: followUp.botSlot,
        })
      : undefined,
  ]);
  if (rules.leftOut.length > 0) log?.(`Rules files not sent with the review: ${rules.leftOut.join(', ')}`);
  if (context.files.length > 0 || context.leftOut.length > 0) {
    log?.(`Repository context: ${context.files.length} files read, ${context.leftOut.length} not read`);
  }
  const prContextOn = contextTokens > 0 && (config.review.prContextTokens ?? DEFAULT_PR_CONTEXT_TOKENS) > 0;
  const prContext =
    followUp && prContextOn
      ? pullRequestContextFiles({
          reviewed: params.files,
          prFiles: followUp.prFiles,
          exclude: config.review.exclude,
          headContent: headContentOf(context.files),
        })
      : [];
  if (followUp && open) {
    const status = open.unchecked ? 'thread status unavailable' : `${open.findings.length} open findings`;
    log?.(`Follow-up review: ${prContext.length} other PR files offered as context, ${status}`);
  }
  return {
    rulesFiles: rules.rulesFiles,
    rulesLeftOut: rules.leftOut,
    contextFiles: [...context.files, ...prContext],
    contextLeftOut: context.leftOut,
    ...(followUp && open
      ? {
          followUp: { sinceSha: followUp.sinceSha, openFindings: open.findings },
          openFindings: {
            shown: open.findings.map((f) => f.id),
            ...(open.total > open.findings.length ? { total: open.total } : {}),
            ...(open.unchecked ? { unchecked: true } : {}),
          },
        }
      : {}),
  };
}

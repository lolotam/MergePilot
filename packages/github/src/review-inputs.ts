import { DEFAULT_CONTEXT_TOKENS, type MergePilotConfig, type RepositoryContextFile } from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import type { FileContent } from './contents.js';
import { gatherRepositoryContext, type ReviewedFile } from './review-context.js';
import { withNestedRulesFiles } from './rules-files.js';

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
  log?: ((message: string) => void) | undefined;
}

export interface ReviewInputs {
  rulesFiles: FileContent[];
  /** Nested rules files left out (ADR-0028), for the summary. */
  rulesLeftOut: string[];
  /** Repository context for `runReview` (ADR-0029). */
  contextFiles: RepositoryContextFile[];
  /** Context files the gatherer could not include, for the summary. */
  contextLeftOut: string[];
}

/**
 * What a review reads from the repository besides the diff, shared by the Action and every App
 * bot: the nearest nested owner rules (base commit) and the repository context (head commit).
 * Reads are cached per client, so the bots of one panel read each file once.
 */
export async function gatherReviewInputs(client: GitHubClient, params: ReviewInputsParams): Promise<ReviewInputs> {
  const { owner, repo, config, log } = params;
  const [rules, context] = await Promise.all([
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
      contextTokens: config.review.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    }),
  ]);
  if (rules.leftOut.length > 0) log?.(`Rules files not sent with the review: ${rules.leftOut.join(', ')}`);
  if (context.files.length > 0 || context.leftOut.length > 0) {
    log?.(`Repository context: ${context.files.length} files read, ${context.leftOut.length} not read`);
  }
  return {
    rulesFiles: rules.rulesFiles,
    rulesLeftOut: rules.leftOut,
    contextFiles: context.files,
    contextLeftOut: context.leftOut,
  };
}

/**
 * The exploration step of a single-call review (ADR-0046): the rounds run before the answer, the
 * explored results go into the review prompt when they fit, and the verifier explores from the same
 * read budget afterwards. The step lives in its own module, so the pipeline keeps only the few
 * lines that call it and use what it returns.
 *
 * The step never fails the review: a round that does not fit, a call that fails and a reader that
 * fails all end the exploration and leave the review with what it has.
 */

import type { ExploreLimits } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import { estimateTokens } from './budget.js';
import type { ReviewDeadline } from './call.js';
import {
  allowPathOf,
  BATCHED_EXPLORATION,
  ExploreBudget,
  exploreLimits,
  heldTextsOf,
  runExploration,
  type ExploreInput,
  type ExplorePassInput,
  type ExplorationDisclosure,
} from './explore.js';
import type { ReviewModel } from './model.js';
import type { SpendTracker } from './spend.js';

/** The pipeline reads the exploration through this module, so its types come from here too. */
export type { ExploreInput, ExplorationDisclosure } from './explore.js';

export interface ExploreStepOptions {
  /** The reader the exploration rounds use; without it the exploration stays off. */
  explore: ExploreInput | undefined;
  /** The review config: the explore limits and the skip rules of the paths. */
  review: { explore?: Partial<ExploreLimits> | undefined; exclude: readonly string[] };
  /** Whether the review is batched: a batched review does not explore. */
  batched: boolean;
  model: ReviewModel;
  spend: SpendTracker;
  deadline: ReviewDeadline;
  signal?: AbortSignal | undefined;
  /** The prompt of the review call, before the explored results. */
  prompt: { system: string; user: string };
  /** The estimated tokens of that prompt. */
  promptTokens: number;
  /** The input-token limit the prompt with the explored results must fit. */
  promptLimit: number;
  /** The files the review holds: the patches. */
  files: readonly { path: string; patch: string }[];
  /** The repository context files the review holds. */
  contextFiles: readonly { path: string; content: string }[];
  knownSecrets: readonly Secret[];
  /** The output tokens the review call requests: the money the exploration must not spend. */
  reviewOutputTokens: number;
}

export interface ExploreStepResult {
  /** The prompt of the review call: with the explored results when they fit. */
  prompt: { system: string; user: string };
  /** The estimated tokens of that prompt. */
  promptTokens: number;
  /** The tokens the exploration rounds spent. */
  usage: TokenUsage | undefined;
  /** What the verifier explores with, when a round ran. */
  explorePass: ExplorePassInput | undefined;
  /**
   * What the run discloses about its exploration, as the result carries it. It is read after the
   * verify pass, which may explore as well (ADR-0046).
   */
  disclosure: () => { exploration?: ExplorationDisclosure | undefined };
}

/**
 * Runs the exploration of a single-call review: the rounds, the prompt they end up in, the usage
 * they spent, what the verifier may explore with, and the disclosure of the whole.
 */
export async function exploreBeforeSinglePass(opts: ExploreStepOptions): Promise<ExploreStepResult> {
  const limits = exploreLimits(opts.review);
  const budget = opts.explore ? new ExploreBudget(limits) : undefined;
  const heldTexts = heldTextsOf(opts.files, opts.contextFiles);
  const allowPath = allowPathOf(opts.review.exclude);
  let prompt = opts.prompt;
  let promptTokens = opts.promptTokens;
  let usage: TokenUsage | undefined;

  if (budget && opts.explore && !opts.batched) {
    const explored = await runExploration({
      model: opts.model,
      spend: opts.spend,
      deadline: opts.deadline,
      signal: opts.signal,
      system: opts.prompt.system,
      user: opts.prompt.user,
      rounds: limits.maxRounds,
      limits,
      budget,
      reader: opts.explore.reader,
      heldTexts,
      allowPath,
      knownSecrets: opts.knownSecrets,
      purpose: 'review',
      // The money the review call needs stays out of the exploration's reach.
      reserve: { promptTokens: opts.promptTokens, outputTokens: opts.reviewOutputTokens },
    });
    usage = explored.usage;
    if (explored.block) {
      const user = `${opts.prompt.user}\n\n${explored.block}`;
      const tokens = estimateTokens(opts.prompt.system + user);
      if (tokens <= opts.promptLimit) {
        prompt = { system: opts.prompt.system, user };
        promptTokens = tokens;
      } else {
        budget.noteSkipped('explored results did not fit the input-token limit');
      }
    }
  }

  // The verifier explores from the same read budget, but only when a round ran.
  const explorePass =
    budget && opts.explore && !opts.batched && budget.rounds > 0
      ? { reader: opts.explore.reader, budget, heldTexts, allowPath, limits }
      : undefined;

  return {
    prompt,
    promptTokens,
    usage,
    explorePass,
    disclosure: () => {
      if (!opts.explore || !budget) return {};
      const exploration = opts.batched ? BATCHED_EXPLORATION : budget.disclosure();
      return { exploration };
    },
  };
}

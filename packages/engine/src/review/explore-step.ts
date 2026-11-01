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
import { fitExploredEntries, maxExploredBlockTokens, renderExploredBlock } from './explore-block.js';
import { EXPLORED_SEPARATOR_TOKENS, uniqueExploreEntries, type ExploreEntry } from './explore-requests.js';
import { reviewLimits } from './input-limits.js';
import type { ReviewModel } from './model.js';
import type { SpendTracker } from './spend.js';

/** The pipeline reads the exploration through this module, so its types come from here too. */
export type { ExploreInput, ExplorationDisclosure } from './explore.js';

export interface ExploreStepOptions {
  /** The reader the exploration rounds use; without it the exploration stays off. */
  explore: ExploreInput | undefined;
  budget?: ExploreBudget | undefined;
  priorEntries?: readonly ExploreEntry[] | undefined;
  additionalReserveTokens?: number | undefined;
  additionalReserveOutputTokens?: number | undefined;
  /** Number of later answers that may reuse this evidence. */
  additionalEvidenceCopies?: number | undefined;
  /** Maximum added input per answer, including the separator, within the total batch cap. */
  evidenceTokenLimit?: number | undefined;
  /**
   * The total tokens reserved across every copy of this evidence, as priced by the caller: each
   * copy rides a different batch, whose own prompt headroom it must fit. Planned by the caller
   * that knows the later batches; computed here from this prompt's own headroom otherwise.
   */
  evidenceReserveTokens?: number | undefined;
  /** The review config: the explore limits and the skip rules of the paths. */
  review: { explore?: Partial<ExploreLimits> | undefined; exclude: readonly string[]; callTimeoutMs?: number };
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
  /**
   * The money the verification call needs, when the review verifies: the exploration may not
   * spend it either (ADR-0046).
   */
  verifyReserve?: { promptTokens: number; outputTokens: number } | undefined;
}

export interface ExploreStepResult {
  /** The prompt of the review call: with the explored results when they fit. */
  prompt: { system: string; user: string };
  /** The estimated tokens of that prompt. */
  promptTokens: number;
  /** The tokens the exploration rounds spent. */
  usage: TokenUsage | undefined;
  /** What the verifier explores with, when a round ran: the budget and the review's results. */
  explorePass: ExplorePassInput | undefined;
  /** Gathered originals, kept separately from this answer's fitted evidence. */
  gatheredEntries: readonly ExploreEntry[];
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
  const budget = opts.explore ? (opts.budget ?? new ExploreBudget(limits)) : undefined;
  const heldTexts = heldTextsOf(opts.files, opts.contextFiles);
  const allowPath = allowPathOf(opts.review.exclude);
  let prompt = opts.prompt;
  let promptTokens = opts.promptTokens;
  let usage: TokenUsage | undefined;
  let gatheredEntries: readonly ExploreEntry[] = opts.priorEntries ?? [];
  // The block the review's prompt carries: the verifier judges against the same evidence.
  let priorBlock = '';
  // The entries the review's exploration gathered: the verifier does not show them again when the
  // block above is in its prompt.
  let priorEntries: readonly ExploreEntry[] = [];

  if (budget && opts.explore && !opts.batched) {
    opts.spend.requireAffordableNext();
    const copies = 1 + (opts.additionalEvidenceCopies ?? 0);
    const evidenceRoom = Math.max(0, Math.min(opts.promptLimit - opts.promptTokens, opts.evidenceTokenLimit ?? Infinity));
    const reserve = {
      promptTokens: opts.promptTokens + (opts.additionalReserveTokens ?? 0) +
        (opts.verifyReserve ? opts.verifyReserve.promptTokens + limits.maxReadTokens : 0),
      outputTokens: opts.reviewOutputTokens + (opts.additionalReserveOutputTokens ?? 0) + (opts.verifyReserve?.outputTokens ?? 0),
    };
    const explored = await runExploration({
      model: opts.model,
      spend: opts.spend,
      deadline: opts.deadline,
      signal: opts.signal,
      system: opts.prompt.system,
      user: opts.prompt.user,
      rounds: limits.maxRounds,
      roundTimeoutMs: reviewLimits(opts.review).callTimeoutMs,
      limits,
      budget,
      reader: opts.explore.reader,
      heldTexts,
      allowPath,
      knownSecrets: opts.knownSecrets,
      purpose: 'review',
      // A round whose prompt is over the input-token limit is not sent.
      promptLimit: opts.promptLimit,
      // The money the review call and the verification call need stays out of the exploration's
      // reach. The verification call may carry the review's explored block, so the read budget is
      // reserved for it too.
      reserve,
      evidenceReserveTokens: opts.evidenceReserveTokens ?? (opts.additionalEvidenceCopies === undefined ? undefined
        : (Math.min(evidenceRoom, maxExploredBlockTokens(limits.maxReadTokens, limits.maxRounds * limits.maxRequestsPerRound))
          + EXPLORED_SEPARATOR_TOKENS) * copies),
    });
    usage = explored.usage;
    const entries = uniqueExploreEntries([...explored.entries, ...(opts.priorEntries ?? [])]);
    gatheredEntries = entries;
    // Pricing may change during exploration. Protect every remaining answer before attaching evidence.
    const affordableRoom = affordableEvidenceTokens(opts.spend, reserve, copies, evidenceRoom);
    priorEntries = fitExploredEntries(entries, opts.knownSecrets, affordableRoom - EXPLORED_SEPARATOR_TOKENS);
    const block = renderExploredBlock(priorEntries, opts.knownSecrets);
    // Only newly gathered evidence counts here; carried evidence may fit differently per batch.
    if (explored.entries.some((entry) => !priorEntries.some((kept) =>
      renderExploredBlock([entry], opts.knownSecrets) === renderExploredBlock([kept], opts.knownSecrets),
    ))) budget.noteTrimmed();
    if (!block && entries.length > 0 && affordableRoom < evidenceRoom) budget.noteSkipped('explored results left out: budget limit reached');
    if (block) {
      const user = `${opts.prompt.user}\n\n${block}`;
      const tokens = estimateTokens(opts.prompt.system + user);
      const addedTokens = tokens - opts.promptTokens;
      if (tokens <= opts.promptLimit && opts.spend.canAfford(reserve.promptTokens + addedTokens * copies, reserve.outputTokens)) {
        prompt = { system: opts.prompt.system, user };
        promptTokens = tokens;
        priorBlock = block;
      } else if (tokens > opts.promptLimit) {
        budget.noteTrimmed();
      } else {
        budget.noteSkipped('explored results left out: budget limit reached');
      }
    }
  }

  // The verifier explores from the same read budget, but only when a round ran. It also judges
  // against the results the review explored, even when the read budget is used up by then.
  const explorePass =
    budget && opts.explore && !opts.batched && budget.rounds > 0
      ? { reader: opts.explore.reader, budget, heldTexts, allowPath, limits, priorBlock, priorEntries }
      : undefined;

  return {
    prompt,
    promptTokens,
    usage,
    explorePass,
    gatheredEntries,
    disclosure: () => {
      if (!opts.explore || !budget) return {};
      const exploration = opts.batched ? BATCHED_EXPLORATION : budget.disclosure();
      return { exploration };
    },
  };
}

/** Fits repeated evidence at the current price while leaving all answer and verify reserves intact. */
function affordableEvidenceTokens(spend: SpendTracker, reserve: { promptTokens: number; outputTokens: number }, copies: number, limit: number): number {
  let low = 0;
  let high = limit;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (spend.canAfford(reserve.promptTokens + mid * copies, reserve.outputTokens)) low = mid;
    else high = mid - 1;
  }
  return low;
}

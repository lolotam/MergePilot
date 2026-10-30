/**
 * Read-only repository exploration (ADR-0046): before the review answer, the model may ask for
 * lines of a file, a literal search or a directory listing, through a plain JSON protocol, so a
 * suspicion ("is this guarded somewhere else?") can be checked instead of guessed. The engine
 * holds the protocol and the budget; the caller holds the reader (ADR-0001).
 *
 * Nothing of the pull request runs, and the read content is untrusted data: escaped like the
 * patches, redacted with the review's own secrets, and never treated as instructions.
 */

import { EXPLORE_LIMIT_DEFAULTS, type ExploreLimits } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import { isContextPathAllowed } from '../diff/classify-file.js';
import type { TokenUsage } from '../llm/types.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { estimateTokens } from './budget.js';
import { generateWithTimeout, type ReviewDeadline } from './call.js';
import { ANSWER_TIME_RESERVED, reserveAnswerTime } from './explore-time.js';
import { fitExploredEntries, renderExploredBlock } from './explore-block.js';
import {
  EXPLORED_SEPARATOR_TOKENS,
  executeRequests,
  exploreInstructions,
  exploreJsonSchema,
  parseExploreRequests,
  type ExploreEntry,
} from './explore-requests.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { describeCallError, requestedOutputTokens, type SpendTracker } from './spend.js';
import { combineUsage } from './split.js';

export { EXPLORED_HEADING } from './explore-block.js';

/** The output budget one exploration call requests: the answer is a short list of requests. */
export const EXPLORE_OUTPUT_TOKENS = 2000;

/**
 * The reader the exploration rounds use (ADR-0046, ADR-0001): implemented by the caller at the
 * PR head. Paths are repository-relative with forward slashes; null means "not found" or "not
 * available".
 */
export interface RepositoryReader {
  readFile(path: string): Promise<string | null>;
  listDirectory(dir: string): Promise<string[] | null>;
  /**
   * The paths of the head, and whether the listing is partial: a tree the API truncated holds
   * only part of the repository, so a search over it says so (ADR-0046).
   */
  listPaths(): Promise<{ paths: string[]; truncated: boolean } | null>;
}

/** What the caller passes to turn the exploration on; without it, it stays off. */
export interface ExploreInput {
  reader: RepositoryReader;
}

/** What the run discloses about its exploration (ADR-0046). */
export interface ExplorationDisclosure {
  rounds: number;
  verifierRounds: number;
  requests: number;
  filesRead: string[];
  refused: number;
  /** New evidence was shortened or omitted to meet an input-token limit. */
  trimmed?: boolean;
  skipped?: string;
}

/** What a batched review discloses about its exploration: it does not explore (ADR-0046). */
export const BATCHED_EXPLORATION: ExplorationDisclosure = {
  rounds: 0,
  verifierRounds: 0,
  requests: 0,
  filesRead: [],
  refused: 0,
  skipped: 'batched review',
};

/**
 * The read budget of one review (ADR-0046): the tokens the read content may take across the
 * review's rounds and the verifier, the files that were read, and the counters the disclosure
 * shows.
 */
export class ExploreBudget {
  #remainingTokens: number;
  #rounds = 0;
  #reviewAttempts = 0;
  #verifierRounds = 0;
  #requests = 0;
  #refused = 0;
  #trimmed = false;
  #skipped: string | undefined;
  readonly #filesRead = new Set<string>();
  /** The files read so far, by path: the content is fetched once and kept. */
  readonly readFiles = new Map<string, string | null>();
  /** The content already served, by key: an exact repeat of one of them is free. */
  readonly #served = new Map<string, string>();
  #listPaths: Promise<{ paths: string[]; truncated: boolean } | null> | undefined;

  constructor(limits: ExploreLimits) {
    this.#remainingTokens = limits.maxReadTokens;
  }

  /** The estimated tokens the read content may still take. */
  get remainingTokens(): number {
    return this.#remainingTokens;
  }

  /** Whether the read budget is used up. */
  get usedUp(): boolean {
    return this.#remainingTokens <= 0;
  }

  /** The rounds that ran. */
  get rounds(): number {
    return this.#rounds;
  }

  /** Attempts include failed calls, so a failing provider cannot multiply work per batch. */
  get reviewAttempts(): number {
    return this.#reviewAttempts;
  }

  countReviewAttempt(): void {
    this.#reviewAttempts++;
  }

  /** The requests the model asked for. */
  get requests(): number {
    return this.#requests;
  }

  /** The requests the rules refused. */
  get refused(): number {
    return this.#refused;
  }

  /** The files that were read. */
  get filesRead(): string[] {
    return [...this.#filesRead];
  }

  /** Charges the read content of one result. */
  charge(tokens: number): void {
    this.#remainingTokens = Math.max(0, this.#remainingTokens - tokens);
  }

  /** The content this exact read was served before: the same path and the same range. */
  servedContent(key: string): string | undefined {
    return this.#served.get(key);
  }

  /** Marks a read as served with the content it showed, so an exact repeat shows it again. */
  markServed(key: string, content: string): void {
    this.#served.set(key, content);
  }

  countRound(verifier = false): void {
    if (verifier) this.#verifierRounds += 1;
    else this.#rounds += 1;
  }

  countRequests(count: number): void {
    this.#requests += count;
  }

  countRefused(count: number): void {
    this.#refused += count;
  }

  addFileRead(path: string): void {
    this.#filesRead.add(path);
  }

  /** Why the exploration stopped early, when it did; the first reason is the one that counts. */
  noteSkipped(reason: string): void {
    this.#skipped ??= reason;
  }

  noteTrimmed(): void {
    this.#trimmed = true;
  }

  /** The file paths of the head, read once per review; a failed listing is tried again later. */
  listPaths(reader: RepositoryReader): Promise<{ paths: string[]; truncated: boolean } | null> {
    let pending = this.#listPaths;
    if (!pending) {
      const fresh: Promise<{ paths: string[]; truncated: boolean } | null> = reader.listPaths();
      pending = fresh.catch((err: unknown) => {
        // A rejected listing is not kept: a later find tries again.
        if (this.#listPaths === pending) this.#listPaths = undefined;
        throw err;
      });
      this.#listPaths = pending;
    }
    return pending;
  }

  /** What the run discloses about its exploration. */
  disclosure(): ExplorationDisclosure {
    return {
      rounds: this.#rounds,
      verifierRounds: this.#verifierRounds,
      requests: this.#requests,
      filesRead: [...this.#filesRead],
      refused: this.#refused,
      ...(this.#trimmed ? { trimmed: true } : {}),
      ...(this.#skipped ? { skipped: this.#skipped } : {}),
    };
  }
}

/** The exploration limits of a config, defaulted for one built in code without the schema. */
export function exploreLimits(review: { explore?: Partial<ExploreLimits> | undefined }): ExploreLimits {
  return {
    maxRounds: review.explore?.maxRounds ?? EXPLORE_LIMIT_DEFAULTS.maxRounds,
    maxRequestsPerRound: review.explore?.maxRequestsPerRound ?? EXPLORE_LIMIT_DEFAULTS.maxRequestsPerRound,
    maxReadTokens: review.explore?.maxReadTokens ?? EXPLORE_LIMIT_DEFAULTS.maxReadTokens,
    maxLinesPerRead: review.explore?.maxLinesPerRead ?? EXPLORE_LIMIT_DEFAULTS.maxLinesPerRead,
  };
}

/**
 * The files a review holds, for the searches of an exploration round (ADR-0046): the patches of
 * the changed files and the context files. Every held text is a source of its own: a path may be
 * held twice (ADR-0030), as the file at the head and as the pull request's patch of it.
 */
export interface HeldTexts {
  /** Every held text of the review, one by one. */
  readonly sources: ReadonlyArray<HeldSource>;
}

/** One held text of a review: the file it belongs to, its content and what it is. */
export interface HeldSource {
  /** The path of the file the text belongs to. */
  readonly path: string;
  /** The text itself: the file at the head or the pull request's patch of it. */
  readonly text: string;
  /** Whether the text is a unified patch: its matches take their lines from its hunk headers. */
  readonly isPatch: boolean;
}

/** The files a review holds, for the searches of an exploration round: nothing is merged. */
export function heldTextsOf(
  files: readonly { path: string; patch: string }[],
  contextFiles: readonly { path: string; content: string; source?: 'pull-request' | undefined }[],
): HeldTexts {
  const sources: HeldSource[] = [];
  for (const file of files) {
    sources.push({ path: file.path, text: file.patch, isPatch: true });
  }
  for (const file of contextFiles) {
    // A PR_CONTEXT file holds the pull request's patch of the file (ADR-0030): its matches take
    // their lines from its hunk headers. A repository context file is the file itself.
    sources.push({ path: file.path, text: file.content, isPatch: file.source === 'pull-request' });
  }
  return { sources };
}

/** Whether a path may be read: the review's own skip rules (sensitive paths, `review.exclude`). */
export function allowPathOf(exclude: readonly string[]): (path: string) => boolean {
  const patterns = [...exclude];
  return (path) => isContextPathAllowed(path, { exclude: patterns, isSensitivePath });
}

/** What the verifier gets to explore with (ADR-0046): the reader, the remaining budget and the
 * files the review holds. */
export interface ExplorePassInput {
  reader: RepositoryReader;
  budget: ExploreBudget;
  heldTexts: HeldTexts;
  allowPath: (path: string) => boolean;
  limits: ExploreLimits;
  /**
   * The block the review's exploration produced: the evidence the verifier judges against. It is
   * empty when the review did not explore, or when its results did not fit its own prompt.
   */
  priorBlock: string;
  /**
   * The entries the review's exploration gathered: the ones the verifier does not show again
   * when the prior block is in its prompt (ADR-0046).
   */
  priorEntries?: readonly ExploreEntry[] | undefined;
}

export interface ExploreRunOptions {
  model: ReviewModel;
  spend: SpendTracker;
  deadline: ReviewDeadline;
  signal?: AbortSignal | undefined;
  /** The prompt of the call that follows the exploration. */
  system: string;
  user: string;
  /** How many rounds may run (the review's own limit; the verifier runs one). */
  rounds: number;
  answerReserveMs?: number | undefined;
  roundTimeoutMs?: number | undefined;
  limits: ExploreLimits;
  budget: ExploreBudget;
  reader: RepositoryReader;
  /** The files this review already holds: the patches and the context files. */
  heldTexts: HeldTexts;
  /** Whether a path may be read (the review's own skip rules). */
  allowPath: (path: string) => boolean;
  knownSecrets: readonly Secret[];
  purpose: 'review' | 'verify';
  /**
   * The money the call that follows the exploration needs: its prompt tokens and the output tokens
   * it requests. The exploration may spend what is left, never the reserve (ADR-0046).
   */
  reserve: { promptTokens: number; outputTokens: number };
  /** The input-token limit the prompt of a round must fit; no limit when it is absent. */
  promptLimit?: number | undefined;
  /**
   * The entries an earlier exploration already showed: they are not shown again, so the same
   * result is not read twice in one prompt (ADR-0046).
   */
  shownEntries?: readonly ExploreEntry[] | undefined;
}

export interface ExploreRunResult {
  /** The EXPLORED section for the user prompt; empty when nothing was read. */
  block: string;
  /** The entries this exploration gathered: the ones its block shows. */
  entries: ExploreEntry[];
  usage: TokenUsage | undefined;
}

/** The key of an entry: its label and its content, so the very same one is recognised. */
function entryKey(entry: ExploreEntry): string {
  return `${entry.label}\u0000${entry.content}`;
}

/**
 * Runs the exploration rounds: each round asks the model for the requests it needs, the results
 * go into the block the next round and the review call carry. A round is skipped when the
 * deadline has passed, the prompt is over the input-token limit or the spend cannot pay for it,
 * and a failing call ends the exploration: the review always goes on with what it has (ADR-0046).
 */
export async function runExploration(opts: ExploreRunOptions): Promise<ExploreRunResult> {
  const { model, spend, budget } = opts;
  const entries: ExploreEntry[] = [];
  // The entries this exploration shows: the very same one is not shown twice, and the ones an
  // earlier exploration showed are not shown again (ADR-0046).
  const shown = new Set<string>();
  for (const entry of opts.shownEntries ?? []) shown.add(entryKey(entry));
  let usage: TokenUsage | undefined;

  for (let round = 1; round <= opts.rounds; round++) {
    if (opts.purpose === 'review' && budget.reviewAttempts >= opts.limits.maxRounds) break;
    if (opts.answerReserveMs !== undefined && opts.deadline.remainingMs <= opts.answerReserveMs + (opts.roundTimeoutMs ?? 0)) {
      budget.noteSkipped(ANSWER_TIME_RESERVED);
      break;
    }
    if (opts.deadline.expired) {
      if (budget.rounds === 0) budget.noteSkipped('time limit reached');
      break;
    }
    if (budget.usedUp) {
      if (budget.rounds === 0) budget.noteSkipped('read budget used up');
      break;
    }
    const system = `${opts.system}\n\n${exploreInstructions(opts.purpose, opts.limits, round, opts.rounds)}`;
    const room = opts.promptLimit === undefined ? Infinity : opts.promptLimit - estimateTokens(system + opts.user) - EXPLORED_SEPARATOR_TOKENS;
    const fitted = fitExploredEntries(entries, opts.knownSecrets, room);
    const block = renderExploredBlock(fitted, opts.knownSecrets);
    if (block !== renderExploredBlock(entries, opts.knownSecrets)) budget.noteTrimmed();
    const user = block ? `${opts.user}\n\n${block}` : opts.user;
    const promptTokens = estimateTokens(system + user);
    // A round whose prompt is over the input-token limit is not sent at all (ADR-0046).
    if (opts.promptLimit !== undefined && promptTokens > opts.promptLimit) {
      if (budget.rounds === 0) budget.noteSkipped('exploration prompt over the input-token limit');
      break;
    }
    const requested = requestedOutputTokens(model, EXPLORE_OUTPUT_TOKENS);
    // The round may run only when the call that follows it still fits: its prompt and its output
    // tokens are reserved, and so is the read budget that may still be added to the prompt. The
    // results so far are reserved too: the call that follows carries them again in its prompt.
    const affordable = spend.canAfford(
      promptTokens + opts.reserve.promptTokens + estimateTokens(block) + budget.remainingTokens,
      requested + opts.reserve.outputTokens,
    );
    if (!affordable) {
      if (budget.rounds === 0) budget.noteSkipped('budget limit reached');
      break;
    }
    const request: ReviewModelRequest = {
      system,
      user,
      maxOutputTokens: EXPLORE_OUTPUT_TOKENS,
      responseSchema: exploreJsonSchema(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    let response: ReviewModelResponse;
    try {
      if (opts.purpose === 'review') budget.countReviewAttempt();
      response = await (opts.roundTimeoutMs === undefined ? model.generate(request) : generateWithTimeout(model, request, opts.roundTimeoutMs));
    } catch (err) {
      spend.record(promptTokens, requested, undefined);
      if (budget.rounds === 0) budget.noteSkipped(describeCallError(err, opts.knownSecrets));
      break;
    }
    spend.record(promptTokens, requested, response.usage);
    usage = combineUsage(usage, response.usage);
    budget.countRound(opts.purpose === 'verify');
    const requests = parseExploreRequests(response.text);
    // An answer that is not the protocol asks for nothing: the exploration ends here.
    if (!requests) break;
    if (requests.length === 0) break;
    const asked = requests.slice(0, opts.limits.maxRequestsPerRound);
    const run = await executeRequests(asked, {
      reader: opts.answerReserveMs === undefined ? opts.reader : reserveAnswerTime(opts.reader, opts.deadline, opts.answerReserveMs, () => budget.noteSkipped(ANSWER_TIME_RESERVED)),
      budget,
      limits: opts.limits,
      allowPath: opts.allowPath,
      heldTexts: opts.heldTexts,
      knownSecrets: opts.knownSecrets,
    });
    budget.countRequests(asked.length);
    budget.countRefused(run.refused);
    // An entry this exploration already shows is not shown twice: the block carries one copy of it.
    for (const entry of run.entries) {
      const key = entryKey(entry);
      if (shown.has(key)) continue;
      shown.add(key);
      entries.push(entry);
    }
  }

  return { block: renderExploredBlock(entries, opts.knownSecrets), entries, usage };
}

/**
 * Explicit, disclosed fallback (ADR-0008). A chain is built per review: when the current model
 * fails after its own retries with one of FALLBACK_TRIGGERS, the next configured model takes
 * over for the rest of that review. It never switches on abort, bad request, context overflow
 * or an unknown error, and the switch is always reported (`modelUsed`, `fallbackFrom`,
 * `fallbackCode`) so the review summary can disclose it. With no fallbacks configured the
 * chain is the primary model alone: the old "no fallback" behaviour.
 *
 * An entry may narrow what lets it in (`fallbackTriggers`, ADR-0027): the other auth method of a
 * dual provider is entered only on quota or rate limit, and the chain looks past it for anything
 * else. The search runs forward only, so an entry passed over is never tried later.
 */
import type { Secret } from '../credentials/secret.js';
import { failureKind, type FailureKind, type LlmFailureCode } from '../llm/failure.js';
import { redactSecrets } from '../security/redact.js';
import type { ReviewAuthMethod, ReviewModel, ReviewModelRequest, ReviewModelResponse, SkippedFallback } from './model.js';

export const FALLBACK_TRIGGERS: readonly FailureKind[] = ['quota', 'rate-limit', 'server', 'network', 'auth'];

const KNOWN_CODES: ReadonlySet<string> = new Set<LlmFailureCode>([
  'INVALID_CREDENTIAL',
  'RATE_LIMIT',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'TIMEOUT',
  'NETWORK',
  'SERVER',
  'BAD_REQUEST',
  'ABORTED',
  'UNKNOWN',
  'QUOTA_EXHAUSTED_ALL_KEYS',
]);

/** The failure category of anything a model threw, or undefined when it is not an LlmFailure. */
export function failureKindOf(error: unknown): FailureKind | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && KNOWN_CODES.has(code) ? failureKind(code as LlmFailureCode) : undefined;
}

export interface FallbackDisclosure {
  /** Label of the model that answered the last call. */
  modelUsed: string;
  /** Label of the configured (primary) model, set only when a fallback took over. */
  fallbackFrom?: string;
  /** Why the primary model was left. */
  fallbackCode?: FailureKind;
  /**
   * The primary model's error message, so the summary and logs say what the provider answered,
   * not only the category. `runReview` redacts the raw message with every secret of the model
   * chain, then puts it on one line and bounds it (2000 characters); display callers cut it
   * further (`fallbackReasonOf` in @mergepilot/github, 300).
   */
  fallbackDetail?: string;
  /** Configured fallbacks that could not take part (e.g. no key), with the reason. */
  skippedFallbacks?: SkippedFallback[];
  /**
   * Set only for a method fallback (ADR-0027): the same provider and model answered on another
   * auth method. Both labels are equal then, so these say what actually changed.
   */
  fallbackFromMethod?: ReviewAuthMethod;
  modelUsedMethod?: ReviewAuthMethod;
}

/** One possible switch: the model that just failed, the entry that would take over, and the call. */
export interface ChainMove {
  leaving: ReviewModel;
  next: ReviewModel;
  request: ReviewModelRequest;
}

/**
 * Whether a move may happen. The pipeline uses it to keep a switch from a subscription to paid
 * API keys inside the review's budget (ADR-0027).
 */
export type MayEnter = (move: ChainMove) => boolean;

export class FallbackChain implements ReviewModel {
  readonly #models: readonly ReviewModel[];
  #index = 0;
  #from: { label: string; code: FailureKind; detail: string | undefined } | undefined;
  #onlySubscriptionCalls = true;
  readonly #mayEnter: MayEnter | undefined;

  constructor(primary: ReviewModel, fallbacks: readonly ReviewModel[] = [], mayEnter?: MayEnter) {
    this.#models = [primary, ...fallbacks];
    this.#mayEnter = mayEnter;
  }

  /**
   * The largest output-token limit any model in the chain would request, so a budget
   * preflight stays a true ceiling whichever model ends up answering.
   */
  outputTokensFor(maxOutputTokens: number): number {
    return Math.max(...this.#models.map((m) => m.outputTokensFor?.(maxOutputTokens) ?? maxOutputTokens));
  }

  /** The answer budget of the model answering now: after a fallback, the fallback's own limit. */
  answerTokensFor(maxOutputTokens: number): number {
    return this.#current().answerTokensFor?.(maxOutputTokens) ?? maxOutputTokens;
  }

  get label(): string {
    return this.#current().label;
  }

  get includedInSubscription(): boolean {
    return this.#current().includedInSubscription === true;
  }

  /** True only when every attempted model call, including failures, was subscription-backed. */
  get onlySubscriptionCalls(): boolean {
    return this.#onlySubscriptionCalls;
  }

  #current(): ReviewModel {
    const model = this.#models[this.#index];
    if (!model) throw new Error('fallback chain is empty');
    return model;
  }

  async generate(request: ReviewModelRequest): Promise<ReviewModelResponse> {
    for (;;) {
      const model = this.#current();
      this.#onlySubscriptionCalls &&= model.includedInSubscription === true;
      try {
        return await model.generate(request);
      } catch (error) {
        const kind = failureKindOf(error);
        if (request.signal?.aborted || !kind || !FALLBACK_TRIGGERS.includes(kind)) throw error;
        const next = this.#nextEntry(kind, request);
        if (next === undefined) throw error;
        // Recorded only once a switch really happens, so a rethrown failure discloses none.
        this.#from ??= { label: model.label, code: kind, detail: detailOf(error) };
        this.#index = next;
      }
    }
  }

  /** The first later entry that this failure kind lets in and that may take this request. */
  #nextEntry(kind: FailureKind, request: ReviewModelRequest): number | undefined {
    for (let index = this.#index + 1; index < this.#models.length; index++) {
      const candidate = this.#models[index];
      if (!candidate || !(candidate.fallbackTriggers ?? FALLBACK_TRIGGERS).includes(kind)) continue;
      if (this.#mayEnter && !this.#mayEnter({ leaving: this.#current(), next: candidate, request })) continue;
      return index;
    }
    return undefined;
  }

  /**
   * What to disclose about the chain. `secrets` is required: the primary's raw error message is
   * redacted with it first, and only then put on one line and bounded.
   */
  disclosure(secrets: Secret[]): FallbackDisclosure {
    const skipped = this.#models[0]?.skippedFallbacks ?? [];
    return {
      modelUsed: this.label,
      ...(this.#from ? { fallbackFrom: this.#from.label, fallbackCode: this.#from.code } : {}),
      ...(this.#from?.detail ? { fallbackDetail: disclosedDetail(this.#from.detail, secrets) } : {}),
      ...(skipped.length > 0 ? { skippedFallbacks: [...skipped] } : {}),
      ...this.#methodSwitch(),
    };
  }

  /** The two auth methods, only when the model that answered is the primary's own model. */
  #methodSwitch(): Pick<FallbackDisclosure, 'fallbackFromMethod' | 'modelUsedMethod'> {
    const from = this.#models[0]?.authMethod;
    const used = this.#current().authMethod;
    if (!this.#from || this.#from.label !== this.label || !from || !used || from === used) return {};
    return { fallbackFromMethod: from, modelUsedMethod: used };
  }
}

/** The raw message, untouched: whitespace is collapsed only after redaction, so a secret still matches. */
function detailOf(error: unknown): string | undefined {
  return error instanceof Error && error.message.trim() ? error.message : undefined;
}

// A bound on what is kept and logged; applied after redaction, so it never splits a secret.
const MAX_DISCLOSED_DETAIL = 2000;

function disclosedDetail(raw: string, secrets: Secret[]): string {
  const oneLine = redactSecrets(raw, secrets).text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DISCLOSED_DETAIL ? oneLine.slice(0, MAX_DISCLOSED_DETAIL) : oneLine;
}

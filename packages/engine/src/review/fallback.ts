/**
 * Explicit, disclosed fallback (ADR-0008). A chain is built per review: when the current model
 * fails after its own retries with one of FALLBACK_TRIGGERS, the next configured model takes
 * over for the rest of that review. It never switches on abort, bad request, context overflow
 * or an unknown error, and the switch is always reported (`modelUsed`, `fallbackFrom`,
 * `fallbackCode`) so the review summary can disclose it. With no fallbacks configured the
 * chain is the primary model alone: the old "no fallback" behaviour.
 */
import { failureKind, type FailureKind, type LlmFailureCode } from '../llm/failure.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse, SkippedFallback } from './model.js';

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
   * The primary model's error message (at most 300 characters), so the summary and logs say what
   * the provider answered, not only the category. Callers redact it before showing it.
   */
  fallbackDetail?: string;
  /** Configured fallbacks that could not take part (e.g. no key), with the reason. */
  skippedFallbacks?: SkippedFallback[];
}

export class FallbackChain implements ReviewModel {
  readonly #models: readonly ReviewModel[];
  #index = 0;
  #from: { label: string; code: FailureKind; detail: string | undefined } | undefined;

  constructor(primary: ReviewModel, fallbacks: readonly ReviewModel[] = []) {
    this.#models = [primary, ...fallbacks];
  }

  /**
   * The largest output-token limit any model in the chain would request, so a budget
   * preflight stays a true ceiling whichever model ends up answering.
   */
  outputTokensFor(maxOutputTokens: number): number {
    return Math.max(...this.#models.map((m) => m.outputTokensFor?.(maxOutputTokens) ?? maxOutputTokens));
  }

  get label(): string {
    return this.#current().label;
  }

  #current(): ReviewModel {
    const model = this.#models[this.#index];
    if (!model) throw new Error('fallback chain is empty');
    return model;
  }

  async generate(request: ReviewModelRequest): Promise<ReviewModelResponse> {
    for (;;) {
      const model = this.#current();
      try {
        return await model.generate(request);
      } catch (error) {
        const kind = failureKindOf(error);
        const last = this.#index >= this.#models.length - 1;
        if (last || request.signal?.aborted || !kind || !FALLBACK_TRIGGERS.includes(kind)) throw error;
        this.#from ??= { label: model.label, code: kind, detail: detailOf(error) };
        this.#index++;
      }
    }
  }

  disclosure(): FallbackDisclosure {
    const skipped = this.#models[0]?.skippedFallbacks ?? [];
    return {
      modelUsed: this.label,
      ...(this.#from ? { fallbackFrom: this.#from.label, fallbackCode: this.#from.code } : {}),
      ...(this.#from?.detail ? { fallbackDetail: this.#from.detail } : {}),
      ...(skipped.length > 0 ? { skippedFallbacks: [...skipped] } : {}),
    };
  }
}

const MAX_DETAIL = 300;

function detailOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';
  if (!message) return undefined;
  return message.length > MAX_DETAIL ? `${message.slice(0, MAX_DETAIL - 1)}…` : message;
}

import { knownMaxOutputTokens } from '../providers/output-limits.js';
import type { RetryPolicy } from './retry.js';
import type { GenerateOptions, ModelEntry, StreamChunk } from './types.js';

/** `thinking` is the per-call override; an adapter that sizes thinking-off calls differently reads it. */
export type OutputTokenRequest = Pick<GenerateOptions, 'model' | 'effort' | 'maxOutputTokens' | 'thinking'>;

/**
 * The one seam every provider implements (ADR-0003). Only `stream` is required, so an
 * adapter stays small; failures are thrown as `LlmFailure` so callers never see a
 * provider-specific error shape.
 */
export abstract class LlmAdapter {
  abstract readonly provider: string;
  readonly retryPolicy?: RetryPolicy;

  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;

  /**
   * The output-token limit one call actually sends for this model and effort: the answer
   * budget plus any thinking headroom. Adapters build their request from it and the budget
   * preflight prices it, so the two never disagree.
   */
  requestedOutputTokens(options: OutputTokenRequest): number {
    return options.maxOutputTokens;
  }

  /** The most output tokens one call to `model` may ask for; undefined when unknown (ADR-0033). */
  outputLimit(model: string): number | undefined {
    return knownMaxOutputTokens(this.provider, model);
  }

  listModels?(): Promise<ModelEntry[]>;
}

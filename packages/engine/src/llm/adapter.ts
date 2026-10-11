import type { RetryPolicy } from './retry.js';
import type { GenerateOptions, ModelEntry, StreamChunk } from './types.js';

/**
 * The one seam every provider implements (ADR-0003). Only `stream` is required, so an
 * adapter stays small; failures are thrown as `LlmFailure` so callers never see a
 * provider-specific error shape.
 */
export abstract class LlmAdapter {
  abstract readonly provider: string;
  readonly retryPolicy?: RetryPolicy;

  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;

  listModels?(): Promise<ModelEntry[]>;
}

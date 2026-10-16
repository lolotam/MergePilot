import type { Secret } from '../credentials/secret.js';
import type { LlmAdapter } from '../llm/adapter.js';
import { collectText } from '../llm/collect.js';
import type { FailureKind } from '../llm/failure.js';
import type { FinishReason, TokenUsage } from '../llm/types.js';
import { answerTokensWithin } from '../providers/output-limits.js';

/** How a review model authenticates to its provider (ADR-0027). */
export type ReviewAuthMethod = 'subscription' | 'api-key';

/**
 * What the review orchestrator needs from "a model": one prompt in, one text answer out.
 * Two kinds of backends satisfy it (ADR-0003, ADR-0006):
 * - API providers, through `modelFromAdapter` over an `LlmAdapter`;
 * - the official Claude Code CLI on the user's own subscription, which implements it directly.
 */
export interface ReviewModel {
  /** Stable label for logs and the review footer, e.g. `anthropic:claude-sonnet-5-5`. */
  readonly label: string;
  /** No incremental API charge: access is covered by the connected consumer subscription. */
  readonly includedInSubscription?: boolean;
  /** Subscription vs API key for this chain entry (ADR-0027 disclosure). */
  readonly authMethod?: ReviewAuthMethod;
  /**
   * Failure kinds that may enter this chain entry (ADR-0027 method fallback). Absent means the
   * global ADR-0008 triggers (`quota`, `rate-limit`, `server`, `network`, `auth`).
   */
  readonly fallbackTriggers?: readonly FailureKind[];
  generate(request: ReviewModelRequest): Promise<ReviewModelResponse>;
  /**
   * Explicit fallback models from the config (ADR-0008), tried in order by the pipeline when
   * this model fails after its retries with quota / rate-limit / server / network / auth.
   */
  readonly fallbacks?: readonly ReviewModel[];
  /**
   * Credentials this model and its fallbacks send. The pipeline adds them to the secrets it
   * redacts from every prompt, so no configured key (a fallback's included) reaches any model.
   */
  readonly secrets?: readonly Secret[];
  /** Configured fallbacks left out before the review, each with a reason to disclose. */
  readonly skippedFallbacks?: readonly SkippedFallback[];
  /**
   * The output-token limit one call actually requests for an answer budget of `maxOutputTokens`
   * (thinking headroom included). Absent means exactly `maxOutputTokens`.
   */
  outputTokensFor?(maxOutputTokens: number): number;
  /**
   * The answer budget a call really gets for `maxOutputTokens`: lower when the model's known output
   * limit leaves less room beside its thinking headroom (ADR-0033). `thinking: 'off'` sizes it for a
   * call sent with thinking off; without it, for the configured effort. Absent means `maxOutputTokens`.
   */
  answerTokensFor?(maxOutputTokens: number, thinking?: 'off'): number;
}

/** The caller's known secrets plus every key the model and its fallbacks send, for redaction. */
export function secretsToRedact(
  known: readonly Secret[],
  model: ReviewModel,
  fallbacks: readonly ReviewModel[] = model.fallbacks ?? [],
): Secret[] {
  return [...known, ...(model.secrets ?? []), ...fallbacks.flatMap((m) => m.secrets ?? [])];
}

export interface SkippedFallback {
  /** `provider:model` of the configured entry. */
  label: string;
  reason: string;
}

export interface ReviewModelRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** JSON schema for the answer; backends that cannot enforce it still receive it in the prompt. */
  responseSchema?: Record<string, unknown>;
  /**
   * `off` asks for this call without thinking: the one retry after an empty, reasoning-only
   * reply (ADR-0013). Backends that cannot switch thinking off ignore it.
   */
  thinking?: 'off';
  signal?: AbortSignal;
}

export interface ReviewModelResponse {
  text: string;
  /** Absent when the backend does not report usage (e.g. subscription CLI). */
  usage?: TokenUsage;
  finishReason: FinishReason;
}

/** Adapts any API `LlmAdapter` to the orchestrator's `ReviewModel`; `effort` is the configured thinking effort. */
export function modelFromAdapter(adapter: LlmAdapter, model: string, effort?: string): ReviewModel {
  const requested = (maxOutputTokens: number, thinking?: 'off'): number =>
    adapter.requestedOutputTokens({ model, maxOutputTokens, ...(effort ? { effort } : {}), ...(thinking ? { thinking } : {}) });
  // Every call stays within the model's known output limit, its thinking headroom kept (ADR-0033).
  // A call's own thinking override sizes its headroom; estimates use the configured effort.
  const answerTokensFor = (maxOutputTokens: number, thinking?: 'off'): number =>
    answerTokensWithin(adapter.outputLimit(model), maxOutputTokens, requested(maxOutputTokens, thinking));
  return {
    label: `${adapter.provider}:${model}`,
    outputTokensFor: (maxOutputTokens) => requested(answerTokensFor(maxOutputTokens)),
    answerTokensFor,
    async generate(request) {
      const result = await collectText(
        adapter.stream({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          maxOutputTokens: answerTokensFor(request.maxOutputTokens, request.thinking),
          ...(effort ? { effort } : {}),
          ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
          ...(request.thinking ? { thinking: request.thinking } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      );
      return { text: result.text, usage: result.usage, finishReason: result.finishReason };
    },
  };
}

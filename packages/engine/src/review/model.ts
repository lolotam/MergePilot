import type { LlmAdapter } from '../llm/adapter.js';
import { collectText } from '../llm/collect.js';
import type { FinishReason, TokenUsage } from '../llm/types.js';

/**
 * What the review orchestrator needs from "a model": one prompt in, one text answer out.
 * Two kinds of backends satisfy it (ADR-0003, ADR-0006):
 * - API providers, through `modelFromAdapter` over an `LlmAdapter`;
 * - the official Claude Code CLI on the user's own subscription, which implements it directly.
 */
export interface ReviewModel {
  /** Stable label for logs and the review footer, e.g. `anthropic:claude-sonnet-5-5`. */
  readonly label: string;
  generate(request: ReviewModelRequest): Promise<ReviewModelResponse>;
}

export interface ReviewModelRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** JSON schema for the answer; backends that cannot enforce it still receive it in the prompt. */
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ReviewModelResponse {
  text: string;
  /** Absent when the backend does not report usage (e.g. subscription CLI). */
  usage?: TokenUsage;
  finishReason: FinishReason;
}

/** Adapts any API `LlmAdapter` to the orchestrator's `ReviewModel`. */
export function modelFromAdapter(adapter: LlmAdapter, model: string): ReviewModel {
  return {
    label: `${adapter.provider}:${model}`,
    async generate(request) {
      const result = await collectText(
        adapter.stream({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          maxOutputTokens: request.maxOutputTokens,
          ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      );
      return { text: result.text, usage: result.usage, finishReason: result.finishReason };
    },
  };
}

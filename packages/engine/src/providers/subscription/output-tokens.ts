/**
 * The output-token limit of one subscription call (ADR-0011 amendments, 2026-10-16).
 *
 * - Claude: pi-ai hands the caller's `maxTokens` to Anthropic as `max_tokens` unchanged for an
 *   adaptive-thinking model, whose thinking and answer share that ceiling, so the thinking headroom
 *   is added here. For a budget-thinking model pi-ai adds the budget itself.
 * - Grok (`openai-responses`): pi-ai sends `maxTokens` as `max_output_tokens`, which reasoning
 *   tokens count against, so the OpenAI-style reasoning headroom is added here.
 * - Codex (`openai-codex-responses`): pi-ai sends no output limit, so there is nothing to size.
 */
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import { adaptiveThinkingHeadroom, DEFAULT_THINKING_HEADROOM, thinkingHeadroom } from '../effort.js';

/** The pi-ai model fields that decide how a call thinks; `compat` is read per API. */
export interface SubscriptionModelShape {
  readonly api: string;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Partial<Record<string, string | null>>;
  readonly compat?: unknown;
}

/** pi-ai's Anthropic compat flags this module reads. */
interface ClaudeCompat {
  readonly forceAdaptiveThinking?: boolean;
  readonly supportsMidConvoEffort?: boolean;
}

export interface SubscriptionOutputTokens {
  /** `maxTokens` handed to pi-ai. */
  send: number;
  /** The output limit that reaches the provider: what the budget preflight prices. */
  requested: number;
}

/** `reasoning` is the thinking level pi-ai receives, undefined when it receives none. */
export function subscriptionOutputTokens(
  model: SubscriptionModelShape,
  reasoning: ThinkingLevel | undefined,
  answerTokens: number,
): SubscriptionOutputTokens {
  const capped = (tokens: number): number => Math.min(tokens, model.maxTokens);
  if (model.api === 'openai-responses') {
    const tokens = capped(answerTokens + responsesReasoningHeadroom(model, reasoning));
    return { send: tokens, requested: tokens };
  }
  if (model.api !== 'anthropic-messages') return { send: answerTokens, requested: answerTokens };
  const compat = model.compat as ClaudeCompat | undefined;
  // Managed-effort models always think adaptively; without a level pi-ai runs them at `high`.
  if (compat?.supportsMidConvoEffort === true || (reasoning && compat?.forceAdaptiveThinking === true)) {
    const tokens = capped(answerTokens + adaptiveThinkingHeadroom(reasoning));
    return { send: tokens, requested: tokens };
  }
  if (reasoning) return { send: answerTokens, requested: capped(answerTokens + thinkingHeadroom(reasoning)) };
  return { send: answerTokens, requested: answerTokens };
}

/**
 * Reasoning headroom on the Responses API, sized like the OpenAI API adapter. With no level,
 * pi-ai asks a model that can switch reasoning off for effort `none`; a model that cannot keeps
 * reasoning at its own default.
 */
function responsesReasoningHeadroom(model: SubscriptionModelShape, reasoning: ThinkingLevel | undefined): number {
  if (reasoning) return thinkingHeadroom(reasoning);
  return model.reasoning && model.thinkingLevelMap?.off === null ? DEFAULT_THINKING_HEADROOM : 0;
}

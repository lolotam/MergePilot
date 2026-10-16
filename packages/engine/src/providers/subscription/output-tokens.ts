/**
 * The output-token limit of one subscription call (ADR-0011 amendment, 2026-10-16).
 *
 * pi-ai hands the caller's `maxTokens` to Anthropic as `max_tokens` unchanged for an
 * adaptive-thinking Claude model, whose thinking and answer share that ceiling, so the thinking
 * headroom is added here. For a budget-thinking Claude model pi-ai adds the budget itself. Codex
 * and Grok calls keep the bare answer budget.
 */
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import { adaptiveThinkingHeadroom, thinkingHeadroom } from '../effort.js';

/** The pi-ai model fields that decide how a Claude call thinks; `compat` is read per API. */
export interface SubscriptionModelShape {
  readonly api: string;
  readonly maxTokens: number;
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
  /** The `max_tokens` that reaches the provider: what the budget preflight prices. */
  requested: number;
}

/** `reasoning` is the thinking level pi-ai receives, undefined when it receives none. */
export function subscriptionOutputTokens(
  model: SubscriptionModelShape,
  reasoning: ThinkingLevel | undefined,
  answerTokens: number,
): SubscriptionOutputTokens {
  if (model.api !== 'anthropic-messages') return { send: answerTokens, requested: answerTokens };
  const compat = model.compat as ClaudeCompat | undefined;
  const capped = (tokens: number): number => Math.min(tokens, model.maxTokens);
  // Managed-effort models always think adaptively; without a level pi-ai runs them at `high`.
  if (compat?.supportsMidConvoEffort === true || (reasoning && compat?.forceAdaptiveThinking === true)) {
    const tokens = capped(answerTokens + adaptiveThinkingHeadroom(reasoning));
    return { send: tokens, requested: tokens };
  }
  if (reasoning) return { send: answerTokens, requested: capped(answerTokens + thinkingHeadroom(reasoning)) };
  return { send: answerTokens, requested: answerTokens };
}

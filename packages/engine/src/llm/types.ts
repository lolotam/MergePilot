/**
 * Provider-neutral LLM vocabulary. The shape follows the DeepSeek Harness `dsh-llm`
 * contract (MIT, (c) 2026 DeepSeek) reduced to what a review engine needs (ADR-0003).
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateOptions {
  model: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  /** JSON schema the provider should constrain its output to, when it supports that. */
  responseSchema?: Record<string, unknown>;
}

/** Input, output and cache counts are disjoint: cached tokens are not repeated in `inputTokens`. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type FinishReason = 'stop' | 'max-tokens' | 'aborted' | 'error';

export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

export interface ModelEntry {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

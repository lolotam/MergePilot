/**
 * The Cloud Code Assist request and SSE response (ADR-0032 §7). Review calls are text only: no
 * tools, function declarations or search grounding are ever sent.
 */
import { LlmFailure } from '../../../llm/failure.js';
import type { GenerateOptions } from '../../../llm/types.js';
import { DEFAULT_THINKING_HEADROOM, geminiThinkingConfig, geminiThinksByDefault, thinkingHeadroom } from '../../effort.js';
import { ANTIGRAVITY_PROVIDER } from './errors.js';

type Effortful = Pick<GenerateOptions, 'model' | 'effort' | 'thinking' | 'maxOutputTokens'>;

function claudeThinkingBudget(options: Effortful): number {
  if (options.thinking === 'off') return 0;
  return thinkingHeadroom(options.effort);
}

/** The answer budget plus the thinking headroom this model and effort take. */
export function antigravityOutputTokens(options: Effortful): number {
  if (options.model.startsWith('claude-')) return options.maxOutputTokens + claudeThinkingBudget(options);
  if (!options.model.startsWith('gemini-')) return options.maxOutputTokens;
  const effort = options.thinking === 'off' ? 'off' : options.effort;
  if (effort !== undefined) {
    const config = geminiThinkingConfig(options.model, effort);
    const thinks = config !== undefined && !('thinkingBudget' in config && config.thinkingBudget === 0);
    return options.maxOutputTokens + (thinks ? thinkingHeadroom(effort) : 0);
  }
  return options.maxOutputTokens + (geminiThinksByDefault(options.model) ? DEFAULT_THINKING_HEADROOM : 0);
}

function thinkingConfig(options: Effortful): Record<string, unknown> | undefined {
  if (options.model.startsWith('claude-')) {
    const budget = claudeThinkingBudget(options);
    return budget > 0 ? { thinkingBudget: budget, includeThoughts: false } : undefined;
  }
  if (!options.model.startsWith('gemini-')) return undefined;
  const config = geminiThinkingConfig(options.model, options.thinking === 'off' ? 'off' : options.effort);
  return config ? { ...config, includeThoughts: false } : undefined;
}

export function generateRequestBody(options: GenerateOptions, projectId: string, requestId: string): Record<string, unknown> {
  const system = options.messages.filter((message) => message.role === 'system').map((message) => message.content);
  const contents = options.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
  const thinking = thinkingConfig(options);
  return {
    project: projectId,
    model: options.model,
    userAgent: 'antigravity',
    requestId,
    request: {
      contents,
      ...(system.length > 0 ? { systemInstruction: { role: 'user', parts: [{ text: system.join('\n\n') }] } } : {}),
      generationConfig: {
        maxOutputTokens: antigravityOutputTokens(options),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    },
  };
}

export interface AntigravityChunk {
  text: string;
  finishReason?: string;
  /** `promptFeedback.blockReason`: Google refused the prompt, so no candidate follows. */
  blockReason?: string;
  usage?: Record<string, unknown>;
  error?: { status: number; body: string };
}

/** One SSE event's JSON: `{ response: { candidates, usageMetadata }, traceId }` or `{ error }`. */
export function parseChunk(data: unknown): AntigravityChunk {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (record.error && typeof record.error === 'object') {
    const code = (record.error as { code?: unknown }).code;
    return { text: '', error: { status: typeof code === 'number' ? code : 500, body: JSON.stringify(record) } };
  }
  const response = (record.response && typeof record.response === 'object' ? record.response : record) as Record<string, unknown>;
  const candidate = Array.isArray(response.candidates) ? (response.candidates[0] as Record<string, unknown> | undefined) : undefined;
  const content = candidate?.content && typeof candidate.content === 'object' ? (candidate.content as { parts?: unknown }) : undefined;
  const parts = Array.isArray(content?.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
  // Thought parts are the model's reasoning, never review text.
  const text = parts.filter((part) => part.thought !== true && typeof part.text === 'string').map((part) => part.text as string).join('');
  const feedback = response.promptFeedback && typeof response.promptFeedback === 'object' ? (response.promptFeedback as { blockReason?: unknown }) : undefined;
  return {
    text,
    ...(typeof feedback?.blockReason === 'string' && feedback.blockReason ? { blockReason: feedback.blockReason } : {}),
    ...(typeof candidate?.finishReason === 'string' ? { finishReason: candidate.finishReason } : {}),
    ...(response.usageMetadata && typeof response.usageMetadata === 'object' ? { usage: response.usageMetadata as Record<string, unknown> } : {}),
  };
}

function parseEvent(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    // A broken event may have carried part of the answer, so the answer cannot be trusted whole.
    throw new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'UNKNOWN', message: 'Google Antigravity sent a malformed stream event' });
  }
}

/**
 * Yields each `data:` event of an SSE body as parsed JSON; a malformed event fails the stream.
 * When the consumer stops early or an error ends the read, the body is cancelled, not just
 * unlocked, so the connection is not left open.
 */
export async function* sseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let finished = false;
  const flush = function* (): Generator<unknown> {
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    yield parseEvent(payload);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') yield* flush();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
    yield* flush();
    finished = true;
  } finally {
    // Cancelling can itself fail on a broken connection; the error that ended the read stays the one thrown.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && value > 0 ? value : 0;
}

/** Gemini usage counts: cached tokens are not repeated in input; thoughts count as output. */
export function usageOf(usage: Record<string, unknown> | undefined) {
  const cached = count(usage?.cachedContentTokenCount);
  return {
    inputTokens: Math.max(0, count(usage?.promptTokenCount) - cached),
    outputTokens: count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

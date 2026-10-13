/**
 * Connection test: one tiny, non-streaming request that proves a key, a model and an effort
 * work together. The result never carries the key; failures come back as a short category
 * (`quota`, `auth`, ...) plus a redacted message instead of a thrown error.
 */
import { randomUUID } from 'node:crypto';
import { failureKind, LlmFailure, type FailureKind } from '../llm/failure.js';
import {
  anthropicThinking,
  compatibleEffortFields,
  DEFAULT_THINKING_HEADROOM,
  geminiThinkingConfig,
  geminiThinksByDefault,
  isCompatibleReasoningModel,
  openAIReasoningEffort,
  openAIThinksByDefault,
  thinkingHeadroom,
} from './effort.js';
import {
  bearerHeaders,
  failureFromResponse,
  failureFromThrown,
  keyValue,
  redactKey,
  type FetchLike,
  type KeyInput,
} from './http.js';
import type { ApiProviderId } from './ids.js';
import { providerEntry, resolveBaseUrl } from './registry.js';
import { decodeSubscription } from '../credentials/subscription.js';
import { Secret } from '../credentials/secret.js';
import { SubscriptionAdapter } from './subscription/adapter.js';

export interface TestConnectionOptions {
  baseUrl?: string;
  effort?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** A failure category, or `invalid-response`: the call succeeded but carried no reply text. */
export type ConnectionFailureCode = FailureKind | 'invalid-response';

export type ConnectionResult =
  | { ok: true; ms: number; model: string; reply: string }
  | { ok: false; ms: number; code: ConnectionFailureCode; message: string };

const PROMPT = 'Reply with the single word OK';
const MAX_OUTPUT_TOKENS = 16;

/**
 * Room for thinking on top of the tiny answer. Models that think by default (Gemini 2.5+/3.x,
 * OpenAI reasoning, DeepSeek reasoner, GLM) spend their output budget on thinking first, so a
 * bare 16 tokens comes back with no reply text and the test wrongly reports a failure.
 */
function testHeadroom(effort: string | undefined, thinks: boolean, thinksByDefault: boolean): number {
  if (thinks) return thinkingHeadroom(effort) || DEFAULT_THINKING_HEADROOM;
  return thinksByDefault && !effort ? DEFAULT_THINKING_HEADROOM : 0;
}
const DEFAULT_TIMEOUT_MS = 30000;

interface PlannedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  reply: (json: Record<string, unknown>) => string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

/** A leading `<think>…</think>` block (closed or cut off by the token limit) some NIM models put in `content`. */
const LEADING_THINK_BLOCK = /^\s*<think>([\s\S]*?)(?:<\/think>|$)/i;

/**
 * The reply in `content`, without a leading think block. A reply that is ONLY a think block
 * still proves the key, the model and the endpoint work, so its reasoning text is returned.
 */
export function contentReply(content: string): string {
  const think = LEADING_THINK_BLOCK.exec(content);
  if (!think) return content.trim();
  const answer = content.slice(think[0].length).trim();
  return answer || (think[1] ?? '').trim();
}

function chatReply(json: Record<string, unknown>): string {
  const message = record(list(json.choices)[0]?.message);
  if (typeof message.content === 'string') {
    const reply = contentReply(message.content);
    if (reply) return reply;
  }
  // Reasoning models (GLM, DeepSeek reasoner, OpenRouter reasoning) may spend the tiny budget on
  // thinking; reasoning text still proves the key, the model and the endpoint work.
  for (const field of ['reasoning_content', 'reasoning']) {
    const value = message[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function plan(provider: ApiProviderId, key: KeyInput, model: string, options: TestConnectionOptions): PlannedRequest {
  const base = resolveBaseUrl(provider, options.baseUrl);
  const messages = [{ role: 'user', content: PROMPT }];
  const json = { 'Content-Type': 'application/json' };

  if (provider === 'anthropic') {
    const thinking = anthropicThinking(model, options.effort);
    return {
      url: `${base}/messages`,
      headers: { ...json, 'x-api-key': keyValue(key) ?? '', 'anthropic-version': '2023-06-01' },
      body: {
        model,
        max_tokens: MAX_OUTPUT_TOKENS + testHeadroom(options.effort, thinking !== undefined, false),
        messages,
        ...(thinking ?? {}),
      },
      reply: (res) =>
        list(res.content)
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text))
          .join(''),
    };
  }
  if (provider === 'gemini') {
    const thinkingConfig = geminiThinkingConfig(model, options.effort);
    return {
      url: `${base}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
      headers: { ...json, 'x-goog-api-key': keyValue(key) ?? '' },
      body: {
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS + testHeadroom(options.effort, thinkingConfig !== undefined, geminiThinksByDefault(model)),
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      },
      reply: (res) =>
        list(record(list(res.candidates)[0]?.content).parts)
          .map((part) => (typeof part.text === 'string' ? part.text : ''))
          .join(''),
    };
  }
  if (provider === 'openai') {
    const effort = openAIReasoningEffort(model, options.effort);
    return {
      url: `${base}/chat/completions`,
      headers: { ...json, ...bearerHeaders(key) },
      body: {
        model,
        messages,
        max_completion_tokens: MAX_OUTPUT_TOKENS + testHeadroom(effort, effort !== undefined, openAIThinksByDefault(model)),
        ...(effort ? { reasoning_effort: effort } : {}),
      },
      reply: chatReply,
    };
  }
  const style = providerEntry(provider).thinkingStyle;
  const effortFields = compatibleEffortFields(style, options.effort);
  const disablesThinking = options.effort === 'off' || options.effort === 'none';
  const compatibleHeadroom = disablesThinking
    ? 0
    : testHeadroom(options.effort, Object.keys(effortFields).length > 0, isCompatibleReasoningModel(provider, model, style));
  return {
    url: `${base}/chat/completions`,
    headers: {
      ...json,
      ...bearerHeaders(key),
      ...(/^https:\/\/opencode\.ai\//.test(base) ? { 'x-opencode-session': randomUUID() } : {}),
    },
    body: {
      model,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS + compatibleHeadroom,
      ...effortFields,
    },
    reply: chatReply,
  };
}

/** Sends one tiny request and reports whether `provider` answered with `model` and this key. */
export async function testConnection(
  provider: ApiProviderId,
  apiKey: KeyInput,
  model: string,
  options: TestConnectionOptions = {},
): Promise<ConnectionResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const elapsed = () => Date.now() - started;

  try {
    const subscription = decodeSubscription(keyValue(apiKey) ?? '', provider);
    if (subscription) {
      const adapter = new SubscriptionAdapter(subscription.provider, new Secret(keyValue(apiKey)!));
      let reply = '';
      for await (const chunk of adapter.stream({ model, messages: [{ role: 'user', content: PROMPT }],
        maxOutputTokens: 1024, signal: controller.signal, ...(options.effort ? { effort: options.effort } : {}) })) {
        if (chunk.type === 'text-delta') reply += chunk.text;
      }
      return reply.trim() ? { ok: true, ms: elapsed(), model, reply: reply.trim() }
        : { ok: false, ms: elapsed(), code: 'invalid-response', message: 'Subscription model returned no text' };
    }
    const request = plan(provider, apiKey, model, options);
    let res: Response;
    try {
      res = await doFetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw failureFromThrown(error, provider, apiKey, controller.signal);
    }
    if (!res.ok) throw await failureFromResponse(res, provider, apiKey);
    let json: Record<string, unknown>;
    try {
      json = record(await res.json());
    } catch {
      return { ok: false, ms: elapsed(), code: 'invalid-response', message: `${provider} answered with a body that is not JSON` };
    }
    const reply = request.reply(json).trim();
    if (!reply) {
      // A blocked candidate or an unexpected payload shape: the model did not really answer.
      return { ok: false, ms: elapsed(), code: 'invalid-response', message: `${provider} answered without any reply text` };
    }
    return { ok: true, ms: elapsed(), model, reply };
  } catch (error) {
    if (timedOut) {
      return { ok: false, ms: elapsed(), code: 'network', message: `${provider} did not answer within ${timeoutMs} ms` };
    }
    const failure =
      error instanceof LlmFailure ? error : failureFromThrown(error, provider, apiKey, controller.signal);
    return { ok: false, ms: elapsed(), code: failureKind(failure.code), message: redactKey(failure.message, apiKey) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Any OpenAI-compatible Chat Completions endpoint: xAI, DeepSeek, NVIDIA NIM, OpenRouter,
 * OpenCode Zen/Go, Z.ai GLM, or a custom server. Ported from the owner's Browser-controle
 * extension (`src/providers/openai-compatible.js`), reduced to one streamed text answer:
 * the agent parts (tools, notebook, screenshots, message compaction) are not ported.
 */
import { randomUUID } from 'node:crypto';
import { LlmAdapter, type OutputTokenRequest } from '../../llm/adapter.js';
import { LlmFailure } from '../../llm/failure.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../../llm/retry.js';
import { ZERO_USAGE, type FinishReason, type GenerateOptions, type StreamChunk, type TokenUsage } from '../../llm/types.js';
import { compatibleEffortFields, thinkingHeadroom, type ThinkingStyle } from '../effort.js';
import { bearerHeaders, failureFromResponse, failureFromThrown, redactKey, type FetchLike, type KeyInput } from '../http.js';
import type { ApiProviderId } from '../ids.js';
import { providerEntry, resolveBaseUrl } from '../registry.js';
import { readSse } from './sse.js';

export interface OpenAICompatibleAdapterOptions {
  provider: ApiProviderId;
  /** Customer-owned key; may be absent only for a keyless custom server. */
  apiKey?: KeyInput;
  /** Required for `custom`; overrides the preset's URL otherwise. */
  baseUrl?: string;
  fetch?: FetchLike;
}

/** OpenCode (Zen and Go) routes by a stable conversation id and rejects requests without one. */
const OPENCODE = /^https:\/\/opencode\.ai\//;

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    prompt_cache_hit_tokens?: number;
  } | null;
  error?: { message?: string; code?: number | string } | string;
}

function mapFinish(reason: string): FinishReason {
  if (reason === 'length') return 'max-tokens';
  if (reason === 'content_filter') return 'error';
  return 'stop';
}

function usageFrom(raw: NonNullable<ChatChunk['usage']>): TokenUsage {
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (raw.prompt_tokens ?? 0) - cached),
    outputTokens: raw.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

export class OpenAICompatibleAdapter extends LlmAdapter {
  override readonly provider: ApiProviderId;
  override readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;

  readonly #key: KeyInput;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #style: ThinkingStyle;
  readonly #streamUsage: boolean;
  readonly #sessionId = randomUUID();

  constructor(options: OpenAICompatibleAdapterOptions) {
    super();
    const entry = providerEntry(options.provider);
    if (entry.kind !== 'openai-compatible') {
      throw new Error(`${options.provider} is not an OpenAI-compatible preset`);
    }
    this.provider = options.provider;
    this.#key = options.apiKey;
    this.#baseUrl = resolveBaseUrl(options.provider, options.baseUrl);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#style = entry.thinkingStyle;
    this.#streamUsage = entry.streamUsage;
  }

  override requestedOutputTokens(options: OutputTokenRequest): number {
    const thinks = Object.keys(compatibleEffortFields(this.#style, options.effort)).length > 0;
    return options.maxOutputTokens + (thinks ? thinkingHeadroom(options.effort) : 0);
  }

  /** The JSON request body; exposed for tests of the effort mapping. */
  requestBody(options: GenerateOptions): Record<string, unknown> {
    const messages = options.messages.map((m) => ({ role: m.role, content: m.content }));
    if (options.responseSchema) {
      // Compatible servers differ on `response_format`; the schema in the prompt works everywhere.
      const instruction = `Respond with a single JSON object matching this JSON schema:\n${JSON.stringify(options.responseSchema)}`;
      const system = messages.find((m) => m.role === 'system');
      if (system) system.content = `${system.content}\n\n${instruction}`;
      else messages.unshift({ role: 'system', content: instruction });
    }
    const effortFields = compatibleEffortFields(this.#style, options.effort);
    return {
      model: options.model,
      messages,
      max_tokens: this.requestedOutputTokens(options),
      stream: true,
      ...(this.#streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...effortFields,
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      throw new LlmFailure({ code: 'ABORTED', provider: this.provider, message: 'request aborted' });
    }
    const response = await this.#post(options);
    if (!response.body) {
      throw new LlmFailure({ code: 'SERVER', provider: this.provider, message: `${this.provider} sent an empty body` });
    }

    let usage: TokenUsage | undefined;
    let finish: FinishReason | undefined;
    let done = false;
    try {
      for await (const { data } of readSse(response.body)) {
        if (options.signal?.aborted) {
          throw new LlmFailure({ code: 'ABORTED', provider: this.provider, message: 'request aborted' });
        }
        if (data === '[DONE]') {
          done = true;
          break;
        }
        const chunk = JSON.parse(data) as ChatChunk;
        if (chunk.error) throw this.#streamError(chunk.error);
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) yield { type: 'text-delta', text: choice.delta.content };
        if (choice?.finish_reason) finish = mapFinish(choice.finish_reason);
        if (chunk.usage) usage = usageFrom(chunk.usage);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new LlmFailure({ code: 'SERVER', provider: this.provider, message: `${this.provider} sent malformed stream data` });
      }
      throw failureFromThrown(error, this.provider, this.#key, options.signal);
    }

    // Neither a finish reason nor [DONE]: the connection dropped mid-answer.
    if (!finish && !done) {
      throw new LlmFailure({
        code: 'NETWORK',
        provider: this.provider,
        message: `${this.provider} stream ended before the answer was complete`,
      });
    }
    yield { type: 'usage', usage: usage ?? { ...ZERO_USAGE } };
    yield { type: 'finish', reason: finish ?? 'stop' };
  }

  async #post(options: GenerateOptions): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...bearerHeaders(this.#key),
          ...(OPENCODE.test(this.#baseUrl) ? { 'x-opencode-session': this.#sessionId } : {}),
        },
        body: JSON.stringify(this.requestBody(options)),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw failureFromThrown(error, this.provider, this.#key, options.signal);
    }
    if (!response.ok) throw await failureFromResponse(response, this.provider, this.#key);
    return response;
  }

  #streamError(error: NonNullable<ChatChunk['error']>): LlmFailure {
    const message = typeof error === 'string' ? error : (error.message ?? JSON.stringify(error));
    const status = typeof error === 'object' && typeof error.code === 'number' ? error.code : undefined;
    const code = status === 429 ? 'RATE_LIMIT' : status === 401 || status === 403 ? 'INVALID_CREDENTIAL' : 'SERVER';
    return new LlmFailure({
      code,
      provider: this.provider,
      message: `${this.provider} stream error: ${redactKey(message, this.#key).slice(0, 300)}`,
      ...(status !== undefined ? { status } : {}),
    });
  }
}

/**
 * Any OpenAI-compatible Chat Completions endpoint: xAI, DeepSeek, NVIDIA NIM, OpenRouter, Vercel AI Gateway,
 * OpenCode Zen/Go, Z.ai GLM, or a custom server. Ported from the owner's Browser-controle
 * extension (`src/providers/openai-compatible.js`), reduced to one streamed text answer:
 * the agent parts (tools, notebook, screenshots, message compaction) are not ported.
 */
import { randomUUID } from 'node:crypto';
import { LlmAdapter, type OutputTokenRequest } from '../../llm/adapter.js';
import { LlmFailure } from '../../llm/failure.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../../llm/retry.js';
import { responseSchemaInstruction } from '../../llm/schema-instruction.js';
import { ZERO_USAGE, type FinishReason, type GenerateOptions, type StreamChunk, type TokenUsage } from '../../llm/types.js';
import { DEFAULT_THINKING_HEADROOM, compatibleEffortFields, defaultThinkingHeadroom, effortStopsThinking, isCompatibleReasoningModel, sentEffort, thinkingHeadroom, type ThinkingStyle } from '../effort.js';
import { bearerHeaders, failureFromResponse, failureFromThrown, redactKey, type FetchLike, type KeyInput } from '../http.js';
import type { ApiProviderId } from '../ids.js';
import { providerEntry, resolveBaseUrl } from '../registry.js';
import { readSse } from './sse.js';
import { ThinkFilter } from './think.js';

export interface OpenAICompatibleAdapterOptions {
  provider: ApiProviderId;
  /** Customer-owned key; may be absent only for a keyless custom server. */
  apiKey?: KeyInput;
  /** Required for `custom` (from a trusted source); ignored for presets, which keep their fixed URL. */
  baseUrl?: string;
  fetch?: FetchLike;
}

/**
 * Wordings compatible servers use when they reject JSON mode or an extra request field. Any other
 * 400 (context too long, bad model id, …) is a real error and is not retried.
 */
const JSON_MODE_REJECTED =
  /response[_ ]format|json[_ ]object|json mode|unsupported (?:parameter|field|argument)|unknown (?:parameter|field|argument)|unrecognized|not supported|extra (?:inputs|fields)|additional properties/i;

/** Presets known to support response_format: { type: "json_object" }. */
const JSON_OBJECT_SUPPORTED_PRESETS = new Set<string>([
  'openrouter',
  'deepseek',
  'xai',
  'zai',
  'zai-coding',
]);

/**
 * `reasoning_effort` sent when one call asks for thinking off on an OpenAI-style server: `off`
 * there means "send nothing", which leaves a reasoning model at its default effort, so the
 * lowest value every such server accepts is sent instead (ADR-0013).
 */
const LOWEST_REASONING_EFFORT = 'low';

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

  /** Whether a call with this model and configured effort thinks at all. */
  #thinks(model: string, effort: string | undefined): boolean {
    if (effort === undefined) return isCompatibleReasoningModel(this.provider, model, this.#style);
    const isOff = effort === 'off' || effort === 'none';
    return !isOff && Object.keys(compatibleEffortFields(this.#style, effort, model)).length > 0;
  }

  /**
   * The effort one call really uses. A per-call `thinking: 'off'` (the retry after an empty,
   * reasoning-only reply) wins over the configured effort: GLM gets `thinking: disabled`, an
   * OpenAI-style reasoning model the lowest `reasoning_effort`; other styles keep the effort.
   */
  #effortFor(options: Pick<GenerateOptions, 'model' | 'effort' | 'thinking'>): string | undefined {
    if (options.thinking !== 'off') return options.effort;
    if (this.#style === 'glm' || this.#style === 'deepseek') return 'off';
    // MiniMax cannot turn its thinking off: the shallowest depth it accepts is sent instead.
    if (this.#style === 'minimax') return LOWEST_REASONING_EFFORT;
    if (this.#style === 'reasoning_effort' && this.#thinks(options.model, options.effort)) {
      return LOWEST_REASONING_EFFORT;
    }
    return options.effort;
  }

  override requestedOutputTokens(options: OutputTokenRequest): number {
    if (options.effort !== undefined) {
      const effortFields = compatibleEffortFields(this.#style, options.effort, options.model);
      // `on` (GLM) and other non-graded switches enable thinking without a size: use the default.
      // The headroom follows the effort the style really sends.
      const thinks = Object.keys(effortFields).length > 0 && !effortStopsThinking(this.#style, options.effort);
      const sized = sentEffort(this.#style, options.effort, options.model);
      const headroom = thinks ? thinkingHeadroom(sized) || DEFAULT_THINKING_HEADROOM : 0;
      return options.maxOutputTokens + headroom;
    }
    const thinksByDefault = isCompatibleReasoningModel(this.provider, options.model, this.#style);
    return options.maxOutputTokens + (thinksByDefault ? defaultThinkingHeadroom(this.#style) : 0);
  }

  /** The JSON request body; exposed for tests of the effort mapping. */
  requestBody(options: GenerateOptions & { omitResponseFormat?: boolean }): Record<string, unknown> {
    const messages = options.messages.map((m) => ({ role: m.role, content: m.content }));
    const sendsJsonObject =
      !options.omitResponseFormat &&
      options.responseSchema !== undefined &&
      JSON_OBJECT_SUPPORTED_PRESETS.has(this.provider);

    if (options.responseSchema) {
      // Compatible servers differ on `response_format`; the schema in the prompt works everywhere.
      const instruction = responseSchemaInstruction(options.responseSchema);
      const system = messages.find((m) => m.role === 'system');
      if (system) system.content = `${system.content}\n\n${instruction}`;
      else messages.unshift({ role: 'system', content: instruction });
    }
    const effort = this.#effortFor(options);
    const effortFields = compatibleEffortFields(this.#style, effort, options.model);
    return {
      model: options.model,
      messages,
      max_tokens: this.requestedOutputTokens({
        model: options.model,
        maxOutputTokens: options.maxOutputTokens,
        ...(effort !== undefined ? { effort } : {}),
      }),
      stream: true,
      ...(this.#streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(sendsJsonObject ? { response_format: { type: 'json_object' } } : {}),
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
    // MiniMax can leave its thinking in `content`; the answer must be the JSON after it.
    const think = this.#style === 'minimax' ? new ThinkFilter() : undefined;
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
        const text = choice?.delta?.content;
        if (text) {
          const clean = think ? think.push(text) : text;
          if (clean) yield { type: 'text-delta', text: clean };
        }
        if (choice?.finish_reason) finish = mapFinish(choice.finish_reason);
        if (chunk.usage) usage = usageFrom(chunk.usage);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new LlmFailure({ code: 'SERVER', provider: this.provider, message: `${this.provider} sent malformed stream data` });
      }
      throw failureFromThrown(error, this.provider, this.#key, options.signal);
    }

    const tail = think?.flush();
    if (tail?.unterminated) {
      // The thinking never closed, so the answer is not the text the model meant to give.
      // The call fails instead of returning an empty answer, so the retry rules see it.
      throw new LlmFailure({
        code: 'UNKNOWN',
        provider: this.provider,
        message: 'MiniMax left an unterminated <think> block',
      });
    }
    if (tail?.text) yield { type: 'text-delta', text: tail.text };

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
    const sendsJsonObject =
      options.responseSchema !== undefined &&
      JSON_OBJECT_SUPPORTED_PRESETS.has(this.provider);

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

    // Retry without JSON mode only when the 400 is about JSON mode itself; read the first body so
    // its connection is released, and keep that body for the error when it is not.
    const firstErrorBody = !response.ok && response.status === 400 && sendsJsonObject ? await response.text() : '';
    if (firstErrorBody && JSON_MODE_REJECTED.test(firstErrorBody)) {
      try {
        const retryResponse = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...bearerHeaders(this.#key),
            ...(OPENCODE.test(this.#baseUrl) ? { 'x-opencode-session': this.#sessionId } : {}),
          },
          body: JSON.stringify(this.requestBody({ ...options, omitResponseFormat: true })),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (retryResponse.ok) {
          return retryResponse;
        }
        response = retryResponse;
      } catch (retryError) {
        throw failureFromThrown(retryError, this.provider, this.#key, options.signal);
      }
    }

    if (!response.ok) {
      // The first body was already read above; rebuild it so the failure keeps its message.
      const failed =
        firstErrorBody && response.bodyUsed
          ? new Response(firstErrorBody, { status: response.status, headers: response.headers })
          : response;
      throw await failureFromResponse(failed, this.provider, this.#key);
    }
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

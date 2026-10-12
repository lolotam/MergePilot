import { GoogleGenAI } from '@google/genai';
import type { Secret } from '../../credentials/secret.js';
import { LlmAdapter, type OutputTokenRequest } from '../../llm/adapter.js';
import { failureFromHttp, LlmFailure } from '../../llm/failure.js';
import type { FinishReason, GenerateOptions, StreamChunk } from '../../llm/types.js';
import { redactSecrets } from '../../security/redact.js';
import { DEFAULT_THINKING_HEADROOM, geminiThinkingConfig, geminiThinksByDefault, thinkingHeadroom } from '../effort.js';
import type {
  GeminiAdapterOptions,
  GeminiLike,
  GeminiStreamChunkLike,
  GeminiUsageMetadataLike,
} from './types.js';

function mapFinishReason(raw: string | undefined): FinishReason {
  if (!raw) return 'stop';
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'max-tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'error';
    default:
      return 'stop';
  }
}

export class GeminiAdapter extends LlmAdapter {
  override readonly provider = 'gemini';
  readonly #client: GeminiLike;
  readonly #apiKey: Secret;

  constructor(options: GeminiAdapterOptions) {
    super();
    this.#apiKey = options.apiKey;
    if (options.client) {
      this.#client = options.client;
    } else {
      this.#client = new GoogleGenAI({ apiKey: options.apiKey.reveal() });
    }
  }

  override requestedOutputTokens(options: OutputTokenRequest): number {
    const thinkingConfig = geminiThinkingConfig(options.model, options.effort);
    if (options.effort !== undefined) {
      const thinks = thinkingConfig !== undefined && !('thinkingBudget' in thinkingConfig && thinkingConfig.thinkingBudget === 0);
      return options.maxOutputTokens + (thinks ? thinkingHeadroom(options.effort) : 0);
    }
    const thinksByDefault = geminiThinksByDefault(options.model);
    return options.maxOutputTokens + (thinksByDefault ? DEFAULT_THINKING_HEADROOM : 0);
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) {
      throw new LlmFailure({
        code: 'ABORTED',
        provider: this.provider,
        message: 'request aborted',
      });
    }

    const systemMessages = options.messages.filter((m) => m.role === 'system');
    const systemInstruction =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join('\n\n')
        : undefined;

    const contents = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const thinkingConfig = geminiThinkingConfig(options.model, options.effort);
    const config: Record<string, unknown> = {
      maxOutputTokens: this.requestedOutputTokens(options),
      ...(thinkingConfig ? { thinkingConfig } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    };

    if (options.responseSchema) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = options.responseSchema;
    }

    let responseStream: AsyncIterable<GeminiStreamChunkLike>;
    try {
      responseStream = await this.#client.models.generateContentStream({
        model: options.model,
        contents,
        config,
      });
    } catch (error) {
      throw this.#translateError(error, options.signal);
    }

    let lastUsageMetadata: GeminiUsageMetadataLike | undefined;
    let lastFinishReason: string | undefined;

    try {
      for await (const chunk of responseStream) {
        if (options.signal?.aborted) {
          throw new LlmFailure({
            code: 'ABORTED',
            provider: this.provider,
            message: 'request aborted',
          });
        }

        if (typeof chunk.text === 'string' && chunk.text.length > 0) {
          yield { type: 'text-delta', text: chunk.text };
        }

        if (chunk.usageMetadata) {
          lastUsageMetadata = chunk.usageMetadata;
        }

        const finishReason = chunk.candidates?.[0]?.finishReason ?? chunk.finishReason;
        if (finishReason) {
          lastFinishReason = finishReason;
        }
      }
    } catch (error) {
      throw this.#translateError(error, options.signal);
    }

    const promptTokenCount = lastUsageMetadata?.promptTokenCount ?? 0;
    const cachedContentTokenCount = lastUsageMetadata?.cachedContentTokenCount ?? 0;
    const candidatesTokenCount = lastUsageMetadata?.candidatesTokenCount ?? 0;
    const thoughtsTokenCount = lastUsageMetadata?.thoughtsTokenCount ?? 0;

    const inputTokens = Math.max(0, promptTokenCount - cachedContentTokenCount);
    const outputTokens = candidatesTokenCount + thoughtsTokenCount;

    yield {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedContentTokenCount,
        cacheWriteTokens: 0,
      },
    };

    yield {
      type: 'finish',
      reason: mapFinishReason(lastFinishReason),
    };
  }

  #translateError(error: unknown, signal?: AbortSignal): LlmFailure {
    if (error instanceof LlmFailure) {
      return error;
    }

    if (
      signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof Error && /aborted/i.test(error.message))
    ) {
      return new LlmFailure({
        code: 'ABORTED',
        provider: this.provider,
        message: 'request aborted',
      });
    }

    const raw = error instanceof Error ? error.message : String(error);
    // Google errors can echo the request URL; never let the key travel in a message.
    const message = redactSecrets(raw, [this.#apiKey]).text;
    const status =
      typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : undefined;

    if (status !== undefined) {
      if (status === 400 && /api[ _]?key.*(?:not valid|invalid)/i.test(message)) {
        const body = message.trim().slice(0, 300);
        return new LlmFailure({
          code: 'INVALID_CREDENTIAL',
          provider: this.provider,
          status: 400,
          message: `${this.provider} returned HTTP 400 (INVALID_CREDENTIAL)${body ? `: ${body}` : ''}`,
        });
      }

      return failureFromHttp({
        status,
        headers: {},
        bodyText: message,
        provider: this.provider,
      });
    }

    return new LlmFailure({
      code: 'UNKNOWN',
      provider: this.provider,
      message,
    });
  }
}

import Anthropic from '@anthropic-ai/sdk';
import type { Secret } from '../../credentials/secret.js';
import { LlmAdapter } from '../../llm/adapter.js';
import { failureFromHttp, LlmFailure } from '../../llm/failure.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../../llm/retry.js';
import type { FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '../../llm/types.js';
import { redactSecrets } from '../../security/redact.js';
import { anthropicThinking, thinkingHeadroom } from '../effort.js';
import type {
  AnthropicAdapterOptions,
  AnthropicLike,
  AnthropicMessageParam,
  AnthropicStreamParams,
  AnthropicSystemBlock,
} from './types.js';

function normalizeHeaders(raw: unknown): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (!raw) return result;
  if (typeof (raw as Headers).forEach === 'function') {
    (raw as Headers).forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        result[key.toLowerCase()] = value;
      } else if (value !== undefined && value !== null) {
        result[key.toLowerCase()] = String(value);
      }
    }
  }
  return result;
}

export class AnthropicAdapter extends LlmAdapter {
  override readonly provider = 'anthropic';
  override readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;

  readonly #apiKey: Secret;
  readonly #client: AnthropicLike;

  constructor(options: AnthropicAdapterOptions) {
    super();
    if ('defaultHeaders' in options && options.defaultHeaders !== undefined) {
      throw new Error('defaultHeaders is not supported');
    }
    this.#apiKey = options.apiKey;
    // maxRetries 0: retries belong to `withRetry` alone; the SDK's own retries would multiply billed calls.
    this.#client = options.client ?? new Anthropic({ apiKey: options.apiKey.reveal(), maxRetries: 0 });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      throw new LlmFailure({
        code: 'ABORTED',
        provider: 'anthropic',
        message: 'request aborted',
      });
    }

    const systemParts: string[] = [];
    const systemMessages = options.messages.filter((m) => m.role === 'system');
    if (systemMessages.length > 0) {
      systemParts.push(systemMessages.map((m) => m.content).join('\n\n'));
    }
    if (options.responseSchema) {
      const schemaStr = JSON.stringify(options.responseSchema);
      systemParts.push(`Respond with a single JSON object matching this JSON schema:\n${schemaStr}`);
    }

    let system: AnthropicSystemBlock[] | undefined;
    if (systemParts.length > 0) {
      system = [
        {
          type: 'text',
          text: systemParts.join('\n\n'),
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    const messages: AnthropicMessageParam[] = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Thinking tokens count against max_tokens, so the answer keeps its own budget on top;
    // Anthropic rejects a custom temperature while thinking is on.
    const thinking = anthropicThinking(options.model, options.effort);
    const streamParams: AnthropicStreamParams = {
      model: options.model,
      max_tokens: options.maxOutputTokens + (thinking ? thinkingHeadroom(options.effort) : 0),
      messages,
      ...(system ? { system } : {}),
      ...(options.temperature !== undefined && !thinking ? { temperature: options.temperature } : {}),
      ...(thinking ?? {}),
    };

    const requestOptions = options.signal ? { signal: options.signal } : undefined;

    let rawStream: AsyncIterable<unknown>;
    try {
      if (typeof this.#client.messages.stream === 'function') {
        rawStream = this.#client.messages.stream(streamParams, requestOptions);
      } else if (typeof this.#client.messages.create === 'function') {
        rawStream = await this.#client.messages.create(
          { ...streamParams, stream: true },
          requestOptions,
        );
      } else {
        throw new Error('Anthropic client does not support streaming messages');
      }
    } catch (error) {
      throw this.#handleError(error, options.signal);
    }

    let startUsage:
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    let deltaUsage:
      | {
          output_tokens?: number;
        }
      | undefined;
    let rawStopReason: string | null = null;

    try {
      for await (const rawEvent of rawStream) {
        if (options.signal?.aborted) {
          throw new LlmFailure({
            code: 'ABORTED',
            provider: 'anthropic',
            message: 'request aborted',
          });
        }
        const event = rawEvent as Record<string, unknown>;
        const eventType = event.type;

        if (eventType === 'message_start') {
          const messageObj = event.message as Record<string, unknown> | undefined;
          startUsage = messageObj?.usage as typeof startUsage;
        } else if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            yield { type: 'text-delta', text: delta.text };
          }
        } else if (eventType === 'message_delta') {
          deltaUsage = event.usage as typeof deltaUsage;
          const deltaObj = event.delta as Record<string, unknown> | undefined;
          if (deltaObj && typeof deltaObj.stop_reason === 'string') {
            rawStopReason = deltaObj.stop_reason;
          }
        }
      }
    } catch (error) {
      throw this.#handleError(error, options.signal);
    }

    const usage: TokenUsage = {
      inputTokens: startUsage?.input_tokens ?? 0,
      outputTokens: deltaUsage?.output_tokens ?? startUsage?.output_tokens ?? 0,
      cacheReadTokens: startUsage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: startUsage?.cache_creation_input_tokens ?? 0,
    };
    yield { type: 'usage', usage };

    const finishReason: FinishReason = rawStopReason === 'max_tokens' ? 'max-tokens' : 'stop';
    yield { type: 'finish', reason: finishReason };
  }

  #handleError(error: unknown, signal?: AbortSignal): LlmFailure {
    if (error instanceof LlmFailure) {
      return error;
    }
    if (
      signal?.aborted ||
      error instanceof Anthropic.APIUserAbortError ||
      (typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error.name === 'APIUserAbortError' || error.name === 'AbortError'))
    ) {
      return new LlmFailure({
        code: 'ABORTED',
        provider: 'anthropic',
        message: error instanceof Error ? error.message : 'request aborted',
      });
    }
    if (
      error instanceof Anthropic.APIConnectionError ||
      error instanceof Anthropic.APIConnectionTimeoutError ||
      (typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError'))
    ) {
      return new LlmFailure({
        code: 'TIMEOUT',
        provider: 'anthropic',
        message: error instanceof Error ? error.message : 'connection error',
      });
    }
    if (
      error instanceof Anthropic.APIError ||
      (typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof (error as { status?: unknown }).status === 'number')
    ) {
      const errObj = error as {
        status?: number;
        headers?: unknown;
        message?: string;
        requestID?: unknown;
      };
      const status = typeof errObj.status === 'number' ? errObj.status : 500;
      const headers = normalizeHeaders(errObj.headers);
      if (typeof errObj.requestID === 'string' && !headers['request-id']) {
        headers['request-id'] = errObj.requestID;
      }
      const rawMsg = errObj.message ?? String(error);
      const bodyText = redactSecrets(rawMsg, [this.#apiKey]).text;
      return failureFromHttp({
        status,
        headers,
        bodyText,
        provider: 'anthropic',
      });
    }
    return new LlmFailure({
      code: 'UNKNOWN',
      provider: 'anthropic',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

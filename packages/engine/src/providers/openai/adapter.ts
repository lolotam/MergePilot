import { OpenAI, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { Secret } from '../../credentials/secret.js';
import { LlmAdapter } from '../../llm/adapter.js';
import { failureFromHttp, LlmFailure } from '../../llm/failure.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../../llm/retry.js';
import { ZERO_USAGE, type FinishReason, type GenerateOptions, type StreamChunk, type TokenUsage } from '../../llm/types.js';
import { redactSecrets } from '../../security/redact.js';
import type { OpenAIAdapterOptions, OpenAILike } from './types.js';

function extractHeaders(rawHeaders: unknown): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (!rawHeaders || typeof rawHeaders !== 'object') {
    return result;
  }
  if (typeof (rawHeaders as Headers).forEach === 'function') {
    (rawHeaders as Headers).forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

export class OpenAIAdapter extends LlmAdapter {
  override readonly provider = 'openai' as const;
  override readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;

  readonly #apiKey: Secret;
  readonly #client: OpenAILike;

  constructor(options: OpenAIAdapterOptions) {
    super();
    if ('baseURL' in options && options.baseURL !== undefined) {
      throw new Error('Custom baseURL is not supported in v1');
    }
    this.#apiKey = options.apiKey;
    // maxRetries 0: retries belong to `withRetry` alone; the SDK's own retries would multiply billed calls.
    this.#client = options.client ?? new OpenAI({ apiKey: options.apiKey.reveal(), maxRetries: 0 });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      throw new LlmFailure({
        code: 'ABORTED',
        provider: this.provider,
        message: 'Request was aborted',
      });
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = options.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: options.model,
      messages,
      max_completion_tokens: options.maxOutputTokens,
      stream: true,
      stream_options: {
        include_usage: true,
      },
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.responseSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'review',
                schema: options.responseSchema,
                strict: false,
              },
            },
          }
        : {}),
    };

    let response: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      response = await this.#client.chat.completions.create(params, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      throw this.#translateError(err, options.signal);
    }

    let finalUsageChunk: TokenUsage | undefined;
    let finalFinishReason: FinishReason = 'stop';

    try {
      for await (const chunk of response) {
        if (options.signal?.aborted) {
          throw new LlmFailure({
            code: 'ABORTED',
            provider: this.provider,
            message: 'Request was aborted',
          });
        }

        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          yield { type: 'text-delta', text: choice.delta.content };
        }

        if (choice?.finish_reason) {
          finalFinishReason = this.#mapFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          finalUsageChunk = {
            inputTokens: Math.max(0, chunk.usage.prompt_tokens - cachedTokens),
            outputTokens: chunk.usage.completion_tokens,
            cacheReadTokens: cachedTokens,
            cacheWriteTokens: 0,
          };
        }
      }
    } catch (err) {
      throw this.#translateError(err, options.signal);
    }

    yield {
      type: 'usage',
      usage: finalUsageChunk ?? { ...ZERO_USAGE },
    };

    yield {
      type: 'finish',
      reason: finalFinishReason,
    };
  }

  #mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'max-tokens';
      case 'content_filter':
        return 'error';
      default:
        return 'stop';
    }
  }

  #redact(text: string): string {
    return redactSecrets(text, [this.#apiKey]).text;
  }

  #translateError(err: unknown, signal?: AbortSignal): LlmFailure {
    if (err instanceof LlmFailure) {
      return err;
    }

    if (
      signal?.aborted ||
      err instanceof APIUserAbortError ||
      (err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError'))
    ) {
      return new LlmFailure({
        code: 'ABORTED',
        provider: this.provider,
        message: err instanceof Error ? this.#redact(err.message) : 'Request was aborted',
      });
    }

    if (
      err instanceof APIConnectionTimeoutError ||
      (err instanceof Error && (err.name === 'APIConnectionTimeoutError' || err.name === 'TimeoutError'))
    ) {
      return new LlmFailure({
        code: 'TIMEOUT',
        provider: this.provider,
        message: err instanceof Error ? this.#redact(err.message) : 'Connection timed out',
      });
    }

    if (
      err instanceof APIError ||
      (typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        typeof (err as { status: unknown }).status === 'number')
    ) {
      const apiError = err as {
        status: number;
        headers?: unknown;
        error?: unknown;
        message?: string;
      };

      const headersRecord = extractHeaders(apiError.headers);

      let rawBody = '';
      if (typeof apiError.error === 'string' && apiError.error.trim().length > 0) {
        rawBody = apiError.error;
      } else if (apiError.error && typeof apiError.error === 'object') {
        const str = JSON.stringify(apiError.error);
        if (str !== '{}') {
          rawBody = str;
        }
      }
      if (!rawBody && typeof apiError.message === 'string') {
        rawBody = apiError.message;
      }

      const redactedBody = this.#redact(rawBody);

      return failureFromHttp({
        status: apiError.status,
        provider: this.provider,
        headers: headersRecord,
        bodyText: redactedBody,
      });
    }

    const rawMsg = err instanceof Error ? err.message : String(err);
    return new LlmFailure({
      code: 'UNKNOWN',
      provider: this.provider,
      message: this.#redact(rawMsg),
    });
  }
}

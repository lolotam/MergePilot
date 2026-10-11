import type { Secret } from '../../credentials/secret.js';

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicStreamParams {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: AnthropicSystemBlock[];
  temperature?: number;
}

export interface AnthropicLike {
  messages: {
    stream?: (
      params: AnthropicStreamParams,
      options?: { signal?: AbortSignal },
    ) => AsyncIterable<unknown>;
    create?: (
      params: AnthropicStreamParams & { stream: true },
      options?: { signal?: AbortSignal },
    ) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
}

export interface AnthropicAdapterOptions {
  apiKey: Secret;
  client?: AnthropicLike;
  defaultHeaders?: never;
}

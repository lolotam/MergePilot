import type { OpenAI } from 'openai';
import type { Secret } from '../../credentials/secret.js';

export interface OpenAILike {
  chat: {
    completions: {
      create(
        params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    };
  };
}

export interface OpenAIAdapterOptions {
  apiKey: Secret;
  client?: OpenAILike;
  baseURL?: never;
}

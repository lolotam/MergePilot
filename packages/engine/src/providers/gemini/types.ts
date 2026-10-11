import type { Secret } from '../../credentials/secret.js';

export interface GeminiContentPart {
  text?: string;
}

export interface GeminiContent {
  role?: string;
  parts?: GeminiContentPart[];
}

export interface GeminiGenerateContentConfig {
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  systemInstruction?: string;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
  [key: string]: unknown;
}

export interface GeminiGenerateContentParams {
  model: string;
  contents: GeminiContent[];
  config?: GeminiGenerateContentConfig;
}

export interface GeminiUsageMetadataLike {
  promptTokenCount?: number | undefined;
  cachedContentTokenCount?: number | undefined;
  candidatesTokenCount?: number | undefined;
  thoughtsTokenCount?: number | undefined;
  totalTokenCount?: number | undefined;
}

export interface GeminiCandidateLike {
  finishReason?: string | undefined;
  index?: number | undefined;
  content?:
    | {
        parts?: GeminiContentPart[] | undefined;
      }
    | undefined;
}

export interface GeminiStreamChunkLike {
  text?: string | undefined;
  candidates?: GeminiCandidateLike[] | undefined;
  usageMetadata?: GeminiUsageMetadataLike | undefined;
  finishReason?: string | undefined;
}

export interface GeminiModelsLike {
  generateContentStream(
    params: GeminiGenerateContentParams,
  ): Promise<AsyncIterable<GeminiStreamChunkLike>> | AsyncIterable<GeminiStreamChunkLike>;
}

export interface GeminiLike {
  models: GeminiModelsLike;
}

export interface GeminiAdapterOptions {
  apiKey: Secret;
  client?: GeminiLike | undefined;
}

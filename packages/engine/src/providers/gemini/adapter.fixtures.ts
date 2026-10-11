import type { GeminiAdapter } from './adapter.js';
import { Secret } from '../../credentials/secret.js';
import type { GenerateOptions, StreamChunk } from '../../llm/types.js';
import type {
  GeminiGenerateContentParams,
  GeminiLike,
  GeminiStreamChunkLike,
} from './types.js';

export function makeFakeClient(
  chunksOrFactory:
    | GeminiStreamChunkLike[]
    | ((
        params: GeminiGenerateContentParams,
      ) =>
        | AsyncIterable<GeminiStreamChunkLike>
        | Promise<AsyncIterable<GeminiStreamChunkLike>>),
): { client: GeminiLike; calls: GeminiGenerateContentParams[] } {
  const calls: GeminiGenerateContentParams[] = [];
  const client: GeminiLike = {
    models: {
      async generateContentStream(params: GeminiGenerateContentParams) {
        calls.push(params);
        if (typeof chunksOrFactory === 'function') {
          return chunksOrFactory(params);
        }
        return (async function* () {
          for (const chunk of chunksOrFactory) {
            yield chunk;
          }
        })();
      },
    },
  };
  return { client, calls };
}

export const FAKE_KEY = new Secret('AIzaSyFakeKey000');

export async function collectChunks(
  adapter: GeminiAdapter,
  options: GenerateOptions,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk);
  }
  return chunks;
}

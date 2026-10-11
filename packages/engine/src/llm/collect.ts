import { ZERO_USAGE, type FinishReason, type StreamChunk, type TokenUsage } from './types.js';

export interface CollectedText {
  text: string;
  usage: TokenUsage;
  finishReason: FinishReason;
}

/** Folds a stream into its full text and summed usage. A stream with no finish chunk counts as an error. */
export async function collectText(stream: AsyncIterable<StreamChunk>): Promise<CollectedText> {
  let text = '';
  const usage: TokenUsage = { ...ZERO_USAGE };
  let finishReason: FinishReason = 'error';

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text;
        break;
      case 'usage':
        usage.inputTokens += chunk.usage.inputTokens;
        usage.outputTokens += chunk.usage.outputTokens;
        usage.cacheReadTokens += chunk.usage.cacheReadTokens;
        usage.cacheWriteTokens += chunk.usage.cacheWriteTokens;
        break;
      case 'finish':
        finishReason = chunk.reason;
        break;
    }
  }

  return { text, usage, finishReason };
}

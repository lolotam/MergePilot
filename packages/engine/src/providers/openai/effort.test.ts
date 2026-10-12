import { describe, expect, it } from 'vitest';
import type { OpenAI } from 'openai';
import { Secret } from '../../credentials/secret.js';
import { collectText } from '../../llm/collect.js';
import { OpenAIAdapter, type OpenAILike } from './index.js';

type Params = OpenAI.Chat.ChatCompletionCreateParamsStreaming;

function capturingClient(sent: Params[]): OpenAILike {
  return {
    chat: {
      completions: {
        async create(params) {
          sent.push(params);
          return (async function* () {})();
        },
      },
    },
  };
}

async function paramsFor(model: string, effort: string): Promise<Params | undefined> {
  const sent: Params[] = [];
  const adapter = new OpenAIAdapter({ apiKey: new Secret('k1'), client: capturingClient(sent) });
  await collectText(adapter.stream({ model, effort, maxOutputTokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
  return sent[0];
}

describe('OpenAIAdapter reasoning_effort', () => {
  it('sends an accepted effort to a reasoning model, with thinking headroom', async () => {
    const params = await paramsFor('gpt-5', 'high');
    expect(params?.reasoning_effort).toBe('high');
    expect(params?.max_completion_tokens).toBe(100 + 16384);
  });

  it('omits values the OpenAI API does not accept', async () => {
    for (const effort of ['xhigh', 'max', 'none', 'off']) {
      const params = await paramsFor('gpt-5', effort);
      expect(params).not.toHaveProperty('reasoning_effort');
      expect(params?.max_completion_tokens).toBe(100);
    }
  });

  it('omits reasoning_effort for non-reasoning models', async () => {
    const params = await paramsFor('gpt-4o', 'high');
    expect(params).not.toHaveProperty('reasoning_effort');
    expect(params?.max_completion_tokens).toBe(100);
  });
});

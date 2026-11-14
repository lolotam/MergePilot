import { describe, expect, it } from 'vitest';
import type { OpenAI } from 'openai';
import { Secret } from '../../credentials/secret.js';
import { collectText } from '../../llm/collect.js';
import { modelFromAdapter } from '../../review/model.js';
import { SpendTracker } from '../../review/spend.js';
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

async function paramsFor(model: string, effort?: string): Promise<Params | undefined> {
  const sent: Params[] = [];
  const adapter = new OpenAIAdapter({ apiKey: new Secret('k1'), client: capturingClient(sent) });
  await collectText(adapter.stream({ model, ...(effort !== undefined ? { effort } : {}), maxOutputTokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
  return sent[0];
}

describe('OpenAIAdapter reasoning_effort', () => {
  it('reserves GPT-6 headroom through the review model and enforces the priced call boundary', async () => {
    const sent: Params[] = [];
    const adapter = new OpenAIAdapter({ apiKey: new Secret('k1'), client: capturingClient(sent) });
    const model = modelFromAdapter(adapter, 'gpt-6.1-sol', 'high');
    const output = model.outputTokensFor!(4096);
    expect(output).toBe(20480);
    const pricing = { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5 };
    expect(new SpendTracker(pricing, 0.3298).canAfford(50000, output)).toBe(true);
    expect(new SpendTracker(pricing, 0.32979).canAfford(50000, output)).toBe(false);
    await model.generate({ system: 'Review', user: 'diff', maxOutputTokens: 4096 });
    expect(sent[0]?.max_completion_tokens).toBe(output);
    expect(sent[0]?.reasoning_effort).toBe('high');
  });

  it.each([
    ['gpt-6.1-sol', 'high', undefined], ['gpt-6.1-sol', 'off', undefined],
    ['gpt-6-sol', 'none', 0.2], ['gpt-4o', 'high', 0.2],
  ] as const)('only sends temperature when %s / %s supports it', async (model, effort, temperature) => {
    const sent: Params[] = [];
    const adapter = new OpenAIAdapter({ apiKey: new Secret('k1'), client: capturingClient(sent) });
    await collectText(adapter.stream({ model, effort, temperature: 0.2, maxOutputTokens: 100,
      messages: [{ role: 'user', content: 'hi' }] }));
    expect(sent[0]?.temperature).toBe(temperature);
  });

  it.each([
    [undefined, undefined, 8192], ['medium', 'medium', 8192], ['high', 'high', 16384],
    ['xhigh', 'xhigh', 24576], ['max', 'max', 32000], ['off', undefined, 8192],
    ['none', undefined, 8192], ['minimal', undefined, 8192], ['unknown', undefined, 8192],
  ] as const)('keeps GPT-6.1 wire and preflight headroom aligned for effort %s', async (effort, sent, headroom) => {
    const params = await paramsFor('gpt-6.1-sol', effort);
    expect(params?.reasoning_effort).toBe(sent);
    expect(params?.max_completion_tokens).toBe(100 + headroom);
    const adapter = new OpenAIAdapter({ apiKey: new Secret('k1'), client: capturingClient([]) });
    expect(adapter.requestedOutputTokens({ model: 'gpt-6.1-sol', maxOutputTokens: 100,
      ...(effort !== undefined ? { effort } : {}) })).toBe(100 + headroom);
  });

  it('sends none only to a GPT-6 model that supports it, reserving no thinking tokens', async () => {
    const params = await paramsFor('gpt-6-sol', 'none');
    expect(params?.reasoning_effort).toBe('none');
    expect(params?.max_completion_tokens).toBe(100);
    const omitted = await paramsFor('gpt-6-sol', 'off');
    expect(omitted).not.toHaveProperty('reasoning_effort');
    expect(omitted?.max_completion_tokens).toBe(8292);
  });

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

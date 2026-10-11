import { describe, expect, it } from 'vitest';
import { collectText } from '../../llm/collect.js';
import { modelFromAdapter } from '../../review/model.js';
import { GeminiAdapter } from './adapter.js';
import { collectChunks, FAKE_KEY, makeFakeClient } from './adapter.fixtures.js';

describe('GeminiAdapter - streaming and assembly', () => {
  it('has provider "gemini"', () => {
    const { client } = makeFakeClient([]);
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    expect(adapter.provider).toBe('gemini');
  });

  it('assembles text deltas and yields disjoint usage and finish chunks', async () => {
    const { client } = makeFakeClient([
      { text: 'Hello, ' },
      { text: '' }, // empty chunk should be skipped
      { text: 'world!' },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 8,
        },
      },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const chunks = await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Say hello' }],
      maxOutputTokens: 100,
    });

    expect(chunks).toEqual([
      { type: 'text-delta', text: 'Hello, ' },
      { type: 'text-delta', text: 'world!' },
      {
        type: 'usage',
        usage: {
          inputTokens: 15,
          outputTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      { type: 'finish', reason: 'stop' },
    ]);

    const result = await collectText(
      adapter.stream({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Say hello' }],
        maxOutputTokens: 100,
      }),
    );

    expect(result.text).toBe('Hello, world!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('counts thoughts tokens as output tokens', async () => {
    const { client } = makeFakeClient([
      { text: 'Answer after deep thinking' },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 25,
        },
      },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const chunks = await collectChunks(adapter, {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'Think hard' }],
      maxOutputTokens: 200,
    });

    const usageChunk = chunks.find((c) => c.type === 'usage');
    expect(usageChunk).toBeDefined();
    if (usageChunk?.type === 'usage') {
      expect(usageChunk.usage.inputTokens).toBe(20);
      expect(usageChunk.usage.outputTokens).toBe(35); // 10 + 25
      expect(usageChunk.usage.cacheReadTokens).toBe(0);
      expect(usageChunk.usage.cacheWriteTokens).toBe(0);
    }
  });

  it('subtracts cached tokens from input tokens', async () => {
    const { client } = makeFakeClient([
      { text: 'Cached answer' },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 65,
          candidatesTokenCount: 20,
        },
      },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const chunks = await collectChunks(adapter, {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'Review cached file' }],
      maxOutputTokens: 200,
    });

    const usageChunk = chunks.find((c) => c.type === 'usage');
    expect(usageChunk).toBeDefined();
    if (usageChunk?.type === 'usage') {
      expect(usageChunk.usage.inputTokens).toBe(35); // 100 - 65
      expect(usageChunk.usage.cacheReadTokens).toBe(65);
      expect(usageChunk.usage.outputTokens).toBe(20);
      expect(usageChunk.usage.cacheWriteTokens).toBe(0);
    }
  });

  it('handles usage with both cached tokens and thoughts tokens', async () => {
    const { client } = makeFakeClient([
      { text: 'Result' },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 200,
          cachedContentTokenCount: 150,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 40,
        },
      },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const result = await collectText(
      adapter.stream({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'Evaluate' }],
        maxOutputTokens: 200,
      }),
    );

    expect(result.usage.inputTokens).toBe(50); // 200 - 150
    expect(result.usage.cacheReadTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(70); // 30 + 40
    expect(result.usage.cacheWriteTokens).toBe(0);
  });
});

describe('GeminiAdapter - finish reasons and configuration', () => {
  it('maps MAX_TOKENS to max-tokens', async () => {
    const { client } = makeFakeClient([
      { text: 'Cut off text' },
      { candidates: [{ finishReason: 'MAX_TOKENS' }] },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const chunks = await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Long response' }],
      maxOutputTokens: 5,
    });

    const finishChunk = chunks.find((c) => c.type === 'finish');
    expect(finishChunk).toEqual({ type: 'finish', reason: 'max-tokens' });
  });

  it('maps SAFETY to error', async () => {
    const { client } = makeFakeClient([
      { text: 'Blocked content' },
      { candidates: [{ finishReason: 'SAFETY' }] },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const chunks = await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Unsafe prompt' }],
      maxOutputTokens: 100,
    });

    const finishChunk = chunks.find((c) => c.type === 'finish');
    expect(finishChunk).toEqual({ type: 'finish', reason: 'error' });
  });

  it.each(['RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'])(
    'maps %s to error',
    async (reason) => {
      const { client } = makeFakeClient([
        { candidates: [{ finishReason: reason }] },
      ]);

      const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
      const chunks = await collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Prompt' }],
        maxOutputTokens: 100,
      });

      const finishChunk = chunks.find((c) => c.type === 'finish');
      expect(finishChunk).toEqual({ type: 'finish', reason: 'error' });
    },
  );

  it('maps other finish reasons to stop', async () => {
    const { client } = makeFakeClient([
      { candidates: [{ finishReason: 'OTHER' }] },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const chunks = await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Prompt' }],
      maxOutputTokens: 100,
    });

    const finishChunk = chunks.find((c) => c.type === 'finish');
    expect(finishChunk).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('sets responseMimeType and responseJsonSchema only when responseSchema is requested', async () => {
    const schema = {
      type: 'object',
      properties: { findings: { type: 'array' } },
      required: ['findings'],
    };

    const { client, calls } = makeFakeClient([
      { text: '{}', candidates: [{ finishReason: 'STOP' }] },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Review diff' }],
      maxOutputTokens: 500,
      responseSchema: schema,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].config?.responseMimeType).toBe('application/json');
    expect(calls[0].config?.responseJsonSchema).toEqual(schema);

    await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Review diff' }],
      maxOutputTokens: 500,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].config?.responseMimeType).toBeUndefined();
    expect(calls[1].config?.responseJsonSchema).toBeUndefined();
  });

  it('maps system messages to config.systemInstruction and user/assistant to contents', async () => {
    const { client, calls } = makeFakeClient([
      { text: 'Acknowledged', candidates: [{ finishReason: 'STOP' }] },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'You are a code reviewer.' },
        { role: 'user', content: 'Check this PR' },
        { role: 'assistant', content: 'I found an issue.' },
        { role: 'user', content: 'Can you explain more?' },
      ],
      maxOutputTokens: 1000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].config?.systemInstruction).toBe('You are a code reviewer.');
    expect(calls[0].contents).toEqual([
      { role: 'user', parts: [{ text: 'Check this PR' }] },
      { role: 'model', parts: [{ text: 'I found an issue.' }] },
      { role: 'user', parts: [{ text: 'Can you explain more?' }] },
    ]);
  });

  it('passes model id dynamically without hardcoding', async () => {
    const { client, calls } = makeFakeClient([
      { text: 'Done', candidates: [{ finishReason: 'STOP' }] },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    await collectChunks(adapter, {
      model: 'custom-experimental-gemini-model-99',
      messages: [{ role: 'user', content: 'Hello' }],
      maxOutputTokens: 10,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('custom-experimental-gemini-model-99');
  });

  it('passes abortSignal from options.signal to config', async () => {
    const controller = new AbortController();
    const { client, calls } = makeFakeClient([
      { text: 'Done', candidates: [{ finishReason: 'STOP' }] },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    await collectChunks(adapter, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      maxOutputTokens: 10,
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].config?.abortSignal).toBe(controller.signal);
  });

  it('constructs with real GoogleGenAI client when no client is injected', () => {
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY });
    expect(adapter).toBeInstanceOf(GeminiAdapter);
    expect(adapter.provider).toBe('gemini');
  });

  it('integrates seamlessly with modelFromAdapter', async () => {
    const { client } = makeFakeClient([
      { text: 'Review feedback' },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 20,
        },
      },
    ]);

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });
    const model = modelFromAdapter(adapter, 'gemini-2.5-pro');

    expect(model.label).toBe('gemini:gemini-2.5-pro');

    const response = await model.generate({
      system: 'System rule',
      user: 'User prompt',
      maxOutputTokens: 100,
    });

    expect(response.text).toBe('Review feedback');
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

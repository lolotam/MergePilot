import { describe, expect, it, vi } from 'vitest';
import { APIConnectionTimeoutError, APIError, APIUserAbortError, type OpenAI } from 'openai';
import { Secret } from '../../credentials/secret.js';
import { collectText } from '../../llm/collect.js';
import { LlmFailure } from '../../llm/failure.js';
import { OpenAIAdapter, type OpenAILike } from './index.js';

type ChunkChoice = OpenAI.Chat.ChatCompletionChunk.Choice;

function makeChunk(
  content?: string,
  finishReason: ChunkChoice['finish_reason'] = null,
  usage?: OpenAI.Chat.ChatCompletionChunk['usage'],
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'test-chunk',
    created: 1,
    model: 'gpt-4o',
    object: 'chat.completion.chunk',
    choices: content !== undefined || finishReason !== null
      ? [{ index: 0, delta: content !== undefined ? { content } : {}, finish_reason: finishReason }]
      : [],
    ...(usage ? { usage } : {}),
  };
}

function createFakeClient(
  chunks: OpenAI.Chat.ChatCompletionChunk[],
  captured?: { params?: OpenAI.Chat.ChatCompletionCreateParamsStreaming; options?: { signal?: AbortSignal } },
): OpenAILike {
  return {
    chat: {
      completions: {
        async create(params, opts) {
          if (captured) { captured.params = params; captured.options = opts; }
          return (async function* () { for (const c of chunks) yield c; })();
        },
      },
    },
  };
}

function throwingClient(err: unknown): OpenAILike {
  return { chat: { completions: { create: async () => { throw err; } } } };
}

describe('OpenAIAdapter', () => {
  const fakeKey = new Secret('sk-test-000');

  describe('happy path & streaming text assembly', () => {
    it('assembles text deltas and yields disjoint usage and finish chunk', async () => {
      const chunks = [
        makeChunk('Hello'),
        makeChunk(' world!'),
        makeChunk(undefined, 'stop'),
        makeChunk(undefined, null, {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 25 },
        }),
      ];
      const client = createFakeClient(chunks);
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      const collected = await collectText(
        adapter.stream({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Say hello' }],
          maxOutputTokens: 1000,
        }),
      );

      expect(collected.text).toBe('Hello world!');
      expect(collected.finishReason).toBe('stop');
      expect(collected.usage).toEqual({
        inputTokens: 75,
        outputTokens: 20,
        cacheReadTokens: 25,
        cacheWriteTokens: 0,
      });
    });
  });

  describe('cached tokens subtraction', () => {
    it('subtracts cached tokens from input tokens and records cacheReadTokens', async () => {
      const chunks = [
        makeChunk('test', 'stop', {
          prompt_tokens: 200,
          completion_tokens: 50,
          total_tokens: 250,
          prompt_tokens_details: { cached_tokens: 80 },
        }),
      ];
      const client = createFakeClient(chunks);
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      const streamChunks = [];
      for await (const chunk of adapter.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 100,
      })) {
        streamChunks.push(chunk);
      }

      const usageChunk = streamChunks.find((c) => c.type === 'usage');
      expect(usageChunk).toEqual({
        type: 'usage',
        usage: { inputTokens: 120, outputTokens: 50, cacheReadTokens: 80, cacheWriteTokens: 0 },
      });
    });

    it('handles usage when cached_tokens is missing or zero', async () => {
      const chunks = [
        makeChunk('test', 'stop', { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }),
      ];
      const client = createFakeClient(chunks);
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      const collected = await collectText(
        adapter.stream({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          maxOutputTokens: 100,
        }),
      );

      expect(collected.usage).toEqual({
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });

  describe('finish_reason mappings', () => {
    it.each([
      ['length', 'max-tokens'],
      ['stop', 'stop'],
      ['content_filter', 'error'],
      ['tool_calls', 'stop'],
      ['unknown_reason', 'stop'],
    ] as const)('maps %s to %s', async (openaiReason, expectedReason) => {
      const chunks = [makeChunk('partial', openaiReason as ChunkChoice['finish_reason'])];
      const client = createFakeClient(chunks);
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      const collected = await collectText(
        adapter.stream({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          maxOutputTokens: 100,
        }),
      );

      expect(collected.finishReason).toBe(expectedReason);
    });
  });

  describe('responseSchema and request parameters', () => {
    it('sends response_format only when responseSchema is provided', async () => {
      const capturedWithSchema: { params?: OpenAI.Chat.ChatCompletionCreateParamsStreaming } = {};
      const clientWithSchema = createFakeClient([], capturedWithSchema);
      const adapterWithSchema = new OpenAIAdapter({ apiKey: fakeKey, client: clientWithSchema });
      const schema = { type: 'object', properties: { review: { type: 'string' } }, required: ['review'] };

      await collectText(
        adapterWithSchema.stream({
          model: 'my-custom-model',
          messages: [
            { role: 'system', content: 'You are a reviewer' },
            { role: 'user', content: 'Review this code' },
          ],
          maxOutputTokens: 500,
          temperature: 0.2,
          responseSchema: schema,
        }),
      );

      expect(capturedWithSchema.params?.model).toBe('my-custom-model');
      expect(capturedWithSchema.params?.max_completion_tokens).toBe(500);
      expect(capturedWithSchema.params?.temperature).toBe(0.2);
      expect(capturedWithSchema.params?.stream).toBe(true);
      expect(capturedWithSchema.params?.stream_options).toEqual({ include_usage: true });
      expect(capturedWithSchema.params?.messages).toEqual([
        { role: 'system', content: 'You are a reviewer' },
        { role: 'user', content: 'Review this code' },
      ]);
      expect(capturedWithSchema.params?.response_format).toEqual({
        type: 'json_schema',
        json_schema: { name: 'review', schema, strict: false },
      });

      const capturedWithoutSchema: { params?: OpenAI.Chat.ChatCompletionCreateParamsStreaming } = {};
      const clientWithoutSchema = createFakeClient([], capturedWithoutSchema);
      const adapterWithoutSchema = new OpenAIAdapter({ apiKey: fakeKey, client: clientWithoutSchema });

      await collectText(
        adapterWithoutSchema.stream({
          model: 'another-model',
          messages: [{ role: 'user', content: 'No schema' }],
          maxOutputTokens: 250,
        }),
      );

      expect(capturedWithoutSchema.params?.response_format).toBeUndefined();
    });
  });

  describe('error handling & secrets redaction', () => {
    it('maps 429 with quota wording to QUOTA', async () => {
      const headers = new Headers({ 'retry-after': '10' });
      const client = throwingClient(
        new APIError(
          429,
          { message: 'You exceeded your current quota, please check your plan and billing details.' },
          '429 You exceeded your current quota',
          headers,
        ),
      );
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      await expect(
        collectText(
          adapter.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }], maxOutputTokens: 100 }),
        ),
      ).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(LlmFailure);
        const failure = err as LlmFailure;
        expect(failure.code).toBe('QUOTA');
        expect(failure.status).toBe(429);
        expect(failure.retryAfterMs).toBe(10000);
        return true;
      });
    });

    it('maps 429 without quota wording to RATE_LIMIT', async () => {
      const client = throwingClient(
        new APIError(429, { message: 'Rate limit reached for requests per min' }, '429 Rate limit', new Headers()),
      );
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      await expect(
        collectText(
          adapter.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }], maxOutputTokens: 100 }),
        ),
      ).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(LlmFailure);
        expect((err as LlmFailure).code).toBe('RATE_LIMIT');
        return true;
      });
    });

    it('ensures 401 message does not contain the key', async () => {
      const secretKey = new Secret('sk-test-secret-12345');
      const client = throwingClient(
        new APIError(
          401,
          { message: 'Incorrect API key provided: sk-test-secret-12345. You can find your API key at...' },
          '401 Incorrect API key provided: sk-test-secret-12345',
          new Headers(),
        ),
      );
      const adapter = new OpenAIAdapter({ apiKey: secretKey, client });

      await expect(
        collectText(
          adapter.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }], maxOutputTokens: 100 }),
        ),
      ).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(LlmFailure);
        const failure = err as LlmFailure;
        expect(failure.code).toBe('INVALID_CREDENTIAL');
        expect(failure.message).not.toContain('sk-test-secret-12345');
        expect(failure.message).toContain('[REDACTED');
        return true;
      });
    });

    it('maps pre-aborted signal to ABORTED', async () => {
      const client = createFakeClient([]);
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });
      const controller = new AbortController();
      controller.abort();

      await expect(
        collectText(
          adapter.stream({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'test' }],
            maxOutputTokens: 100,
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ABORTED', provider: 'openai' });
    });

    it('maps APIUserAbortError to ABORTED', async () => {
      const client = throwingClient(new APIUserAbortError());
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      await expect(
        collectText(
          adapter.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }], maxOutputTokens: 100 }),
        ),
      ).rejects.toMatchObject({ code: 'ABORTED', provider: 'openai' });
    });

    it('maps abort during stream iteration to ABORTED', async () => {
      const controller = new AbortController();
      const client: OpenAILike = {
        chat: {
          completions: {
            async create() {
              return (async function* () {
                yield makeChunk('chunk 1');
                controller.abort();
                yield makeChunk('chunk 2');
              })();
            },
          },
        },
      };

      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      await expect(
        collectText(
          adapter.stream({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'test' }],
            maxOutputTokens: 100,
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ABORTED', provider: 'openai' });
    });

    it('maps APIConnectionTimeoutError to TIMEOUT', async () => {
      const client = throwingClient(new APIConnectionTimeoutError());
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });

      await expect(
        collectText(
          adapter.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }], maxOutputTokens: 100 }),
        ),
      ).rejects.toMatchObject({ code: 'TIMEOUT', provider: 'openai' });
    });
  });

  describe('constructor and options', () => {
    it('sets provider to openai', () => {
      const client = createFakeClient([]);
      const adapter = new OpenAIAdapter({ apiKey: fakeKey, client });
      expect(adapter.provider).toBe('openai');
    });

    it('does not call apiKey.reveal() when client is injected', () => {
      const spySecret = new Secret('sk-spy-test');
      const revealSpy = vi.spyOn(spySecret, 'reveal');
      const client = createFakeClient([]);

      new OpenAIAdapter({ apiKey: spySecret, client });
      expect(revealSpy).not.toHaveBeenCalled();
    });

    it('calls apiKey.reveal() when no client is injected', () => {
      const spySecret = new Secret('sk-spy-build');
      const revealSpy = vi.spyOn(spySecret, 'reveal');

      const adapter = new OpenAIAdapter({ apiKey: spySecret });
      expect(revealSpy).toHaveBeenCalledTimes(1);
      expect(adapter.provider).toBe('openai');
    });

    it('rejects custom baseURL', () => {
      const client = createFakeClient([]);
      expect(
        () => new OpenAIAdapter({ apiKey: fakeKey, client, baseURL: 'https://example.com' as never }),
      ).toThrow();
    });
  });
});

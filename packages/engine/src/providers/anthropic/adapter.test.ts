import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { Secret } from '../../credentials/secret.js';
import { collectText } from '../../llm/collect.js';
import { LlmFailure } from '../../llm/failure.js';
import { DEFAULT_RETRY_POLICY } from '../../llm/retry.js';
import type { GenerateOptions, StreamChunk } from '../../llm/types.js';
import { AnthropicAdapter } from './adapter.js';
import type { AnthropicAdapterOptions, AnthropicLike, AnthropicStreamParams } from './types.js';

class FakeAnthropicClient implements AnthropicLike {
  public lastStreamParams?: AnthropicStreamParams;
  public lastStreamOptions?: { signal?: AbortSignal };
  public eventsToEmit: unknown[] = [];
  public errorToThrowOnCall?: Error;
  public errorToThrowDuringStream?: Error;

  messages = {
    stream: (params: AnthropicStreamParams, options?: { signal?: AbortSignal }) => {
      this.lastStreamParams = params;
      this.lastStreamOptions = options;
      if (this.errorToThrowOnCall) throw this.errorToThrowOnCall;
      const events = this.eventsToEmit;
      const errorDuringStream = this.errorToThrowDuringStream;
      return (async function* () {
        for (const event of events) {
          if (options?.signal?.aborted) throw new Anthropic.APIUserAbortError();
          yield event;
        }
        if (errorDuringStream) throw errorDuringStream;
      })();
    },
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // drain
  }
}

async function expectFailure(fn: () => Promise<unknown>, code: string, status?: number): Promise<LlmFailure> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LlmFailure);
  const failure = thrown as LlmFailure;
  expect(failure.code).toBe(code);
  if (status !== undefined) expect(failure.status).toBe(status);
  return failure;
}

describe('AnthropicAdapter', () => {
  it('has provider "anthropic" and DEFAULT_RETRY_POLICY', () => {
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: new FakeAnthropicClient() });
    expect(adapter.provider).toBe('anthropic');
    expect(adapter.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
    expect(adapter.retryPolicy?.retryableCodes).toContain('SERVER');
  });

  it('rejects defaultHeaders if passed at runtime', () => {
    expect(() => {
      new AnthropicAdapter({
        apiKey: new Secret('sk-test-000'),
        client: new FakeAnthropicClient(),
        defaultHeaders: { 'x-foo': 'bar' } as never,
      } as AnthropicAdapterOptions);
    }).toThrow('defaultHeaders is not supported');
  });

  it('builds an Anthropic SDK client when no client is injected', () => {
    const secret = new Secret('sk-ant-test-construct');
    const adapter = new AnthropicAdapter({ apiKey: secret });
    expect(adapter.provider).toBe('anthropic');
  });

  it('assembles text deltas into full text output', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Say hello' }],
      maxOutputTokens: 100,
    })) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => c.type === 'text-delta');
    expect(textChunks).toEqual([
      { type: 'text-delta', text: 'Hello, ' },
      { type: 'text-delta', text: 'world!' },
    ]);

    const collected = await collectText(
      adapter.stream({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Say hello' }],
        maxOutputTokens: 100,
      }),
    );
    expect(collected.text).toBe('Hello, world!');
    expect(collected.finishReason).toBe('stop');
  });

  it('keeps cache tokens disjoint in usage chunk', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 150,
            output_tokens: 1,
            cache_creation_input_tokens: 25,
            cache_read_input_tokens: 50,
          },
        },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Count' }],
      maxOutputTokens: 200,
    })) {
      chunks.push(chunk);
    }

    const usageChunks = chunks.filter((c) => c.type === 'usage');
    expect(usageChunks).toHaveLength(1);
    expect(usageChunks[0]).toEqual({
      type: 'usage',
      usage: { inputTokens: 150, outputTokens: 42, cacheReadTokens: 50, cacheWriteTokens: 25 },
    });
  });

  it('maps max_tokens correctly in request and response', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [
      { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial text...' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1024 } },
    ];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });
    const options: GenerateOptions = {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'Generate essay' }],
      maxOutputTokens: 1024,
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(options)) {
      chunks.push(chunk);
    }

    expect(fakeClient.lastStreamParams?.model).toBe('claude-opus-5');
    expect(fakeClient.lastStreamParams?.max_tokens).toBe(1024);
    expect(chunks.find((c) => c.type === 'finish')).toEqual({ type: 'finish', reason: 'max-tokens' });
  });

  it.each([
    ['claude-opus-5-5', 4096 + 32768],
    ['claude-sonnet-4-5', 4096 + 16384],
  ])('sends %s at effort high the output limit the budget preflight prices', async (model, limit) => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });

    await drain(adapter.stream({ model, effort: 'high', messages: [{ role: 'user', content: 'Review' }], maxOutputTokens: 4096 }));

    expect(fakeClient.lastStreamParams?.max_tokens).toBe(limit);
    expect(adapter.requestedOutputTokens({ model, effort: 'high', maxOutputTokens: 4096 })).toBe(limit);
  });

  it('maps stop_sequence and other reasons to stop', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [
      { type: 'message_delta', delta: { stop_reason: 'stop_sequence' }, usage: { output_tokens: 10 } },
    ];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Stop test' }],
      maxOutputTokens: 50,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.find((c) => c.type === 'finish')).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('routes system messages to system parameter with cache_control', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });

    await drain(
      adapter.stream({
        model: 'claude-haiku-5-5',
        messages: [
          { role: 'system', content: 'You are a code review assistant.' },
          { role: 'user', content: 'Please review this diff.' },
          { role: 'assistant', content: 'Ready.' },
          { role: 'user', content: 'Here is the code.' },
        ],
        maxOutputTokens: 500,
        temperature: 0.2,
      }),
    );

    expect(fakeClient.lastStreamParams?.system).toEqual([
      { type: 'text', text: 'You are a code review assistant.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(fakeClient.lastStreamParams?.messages).toEqual([
      { role: 'user', content: 'Please review this diff.' },
      { role: 'assistant', content: 'Ready.' },
      { role: 'user', content: 'Here is the code.' },
    ]);
    expect(fakeClient.lastStreamParams?.temperature).toBe(0.2);
  });

  it('appends responseSchema to system prompt without prefill', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

    await drain(
      adapter.stream({
        model: 'claude-sonnet-5-5',
        messages: [
          { role: 'system', content: 'Base system prompt.' },
          { role: 'user', content: 'Review and return JSON.' },
        ],
        maxOutputTokens: 1000,
        responseSchema: schema,
      }),
    );

    const systemBlock = fakeClient.lastStreamParams?.system?.[0];
    expect(systemBlock?.type).toBe('text');
    expect(systemBlock?.cache_control).toEqual({ type: 'ephemeral' });
    expect(systemBlock?.text).toContain('Base system prompt.');
    expect(systemBlock?.text).toContain('Respond with a single JSON object matching this JSON schema:');
    expect(systemBlock?.text).toContain(JSON.stringify(schema));
    expect(fakeClient.lastStreamParams?.messages).toEqual([
      { role: 'user', content: 'Review and return JSON.' },
    ]);
  });

  it('creates system text with responseSchema when no system message is provided', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.eventsToEmit = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }];
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

    await drain(
      adapter.stream({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Evaluate' }],
        maxOutputTokens: 100,
        responseSchema: schema,
      }),
    );

    expect(fakeClient.lastStreamParams?.system).toEqual([
      {
        type: 'text',
        text: `Respond with a single JSON object matching this JSON schema:\n${JSON.stringify(schema)}`,
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('converts 401 APIError to INVALID_CREDENTIAL and redacts the API key', async () => {
    const rawSecret = 'sk-ant-test-secret-key-99999';
    const fakeClient = new FakeAnthropicClient();
    fakeClient.errorToThrowOnCall = new Anthropic.APIError(
      401,
      { error: { message: `Invalid key provided: ${rawSecret}` } },
      `Invalid key provided: ${rawSecret}`,
      new Headers({ 'x-request-id': 'req_401' }),
    );
    const adapter = new AnthropicAdapter({ apiKey: new Secret(rawSecret), client: fakeClient });

    const failure = await expectFailure(
      () => drain(adapter.stream({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 10 })),
      'INVALID_CREDENTIAL',
      401,
    );
    expect(failure.provider).toBe('anthropic');
    expect(failure.message).not.toContain(rawSecret);
    expect(failure.requestId).toBe('req_401');
  });

  it('converts HTTP 529 to SERVER failure', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.errorToThrowOnCall = new Anthropic.APIError(
      529,
      { error: { message: 'Overloaded' } },
      'Anthropic is currently overloaded',
      new Headers(),
    );
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });

    await expectFailure(
      () => drain(adapter.stream({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 10 })),
      'SERVER',
      529,
    );
  });

  it('converts APIUserAbortError and aborted signals to ABORTED', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.errorToThrowOnCall = new Anthropic.APIUserAbortError();
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });

    await expectFailure(
      () => drain(adapter.stream({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 10 })),
      'ABORTED',
    );

    const controller = new AbortController();
    controller.abort();
    await expectFailure(
      () => drain(adapter.stream({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 10,
        signal: controller.signal,
      })),
      'ABORTED',
    );
  });

  it('converts connection error to TIMEOUT', async () => {
    const fakeClient = new FakeAnthropicClient();
    fakeClient.errorToThrowOnCall = new Anthropic.APIConnectionError({ message: 'Failed to connect' });
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: fakeClient });

    await expectFailure(
      () => drain(adapter.stream({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 10 })),
      'TIMEOUT',
    );
  });

  it('supports client with messages.create({ stream: true })', async () => {
    const clientWithCreate: AnthropicLike = {
      messages: {
        create: async () => (async function* () {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Created stream text' } };
          yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } };
        })(),
      },
    };
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: clientWithCreate });
    const collected = await collectText(
      adapter.stream({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Test create' }], maxOutputTokens: 50 }),
    );
    expect(collected.text).toBe('Created stream text');
    expect(collected.finishReason).toBe('stop');
  });
});

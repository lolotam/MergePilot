import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../../credentials/secret.js';
import { collectText } from '../../llm/collect.js';
import { LlmFailure } from '../../llm/failure.js';
import type { GenerateOptions } from '../../llm/types.js';
import { jsonResponse, mockFetch, sseResponse, textResponse } from '../fetch-mock.fixtures.js';
import { OpenAICompatibleAdapter } from './adapter.js';
import { parseSseChunk } from './sse.js';

// Built at runtime so no literal in the repository looks like a real key.
const KEY = ['s', 'k-', 't'.repeat(24)].join('');
const base: GenerateOptions = {
  model: 'grok-4',
  messages: [
    { role: 'system', content: 'You review code.' },
    { role: 'user', content: 'Review this.' },
  ],
  maxOutputTokens: 100,
};

function okStream() {
  return sseResponse([
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } } },
    '[DONE]',
  ]);
}

async function failureOf(promise: Promise<unknown>): Promise<LlmFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmFailure) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('OpenAICompatibleAdapter', () => {
  it('streams text and maps usage, with cached tokens split out', async () => {
    const { fetch, calls } = mockFetch(okStream());
    const adapter = new OpenAICompatibleAdapter({ provider: 'xai', apiKey: new Secret(KEY), fetch });
    const result = await collectText(adapter.stream(base));
    expect(result).toEqual({
      text: 'Hello',
      usage: { inputTokens: 30, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 0 },
      finishReason: 'stop',
    });
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body).toMatchObject({ model: 'grok-4', stream: true, max_tokens: 100, stream_options: { include_usage: true } });
  });

  it('maps DeepSeek cache hits and length finish', async () => {
    const { fetch } = mockFetch(
      sseResponse([
        { choices: [{ delta: { content: 'x' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 4 } },
      ]),
    );
    const adapter = new OpenAICompatibleAdapter({ provider: 'deepseek', apiKey: KEY, fetch });
    const result = await collectText(adapter.stream(base));
    expect(result.finishReason).toBe('max-tokens');
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 1, cacheReadTokens: 4, cacheWriteTokens: 0 });
  });

  it('maps effort by thinking style into the request body', () => {
    const xai = new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY });
    expect(xai.requestBody({ ...base, effort: 'high' })).toMatchObject({ reasoning_effort: 'high', max_tokens: 100 + 16384 });
    expect(xai.requestBody({ ...base, effort: 'off' })).not.toHaveProperty('reasoning_effort');
    const zai = new OpenAICompatibleAdapter({ provider: 'zai', apiKey: KEY });
    expect(zai.requestBody({ ...base, effort: 'on' })).toMatchObject({ thinking: { type: 'enabled' } });
    expect(zai.requestBody({ ...base, effort: 'off' })).toMatchObject({ thinking: { type: 'disabled' } });
    expect(zai.requestBody(base)).not.toHaveProperty('stream_options');
    const deepseek = new OpenAICompatibleAdapter({ provider: 'deepseek', apiKey: KEY });
    expect(deepseek.requestBody({ ...base, effort: 'high' })).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(deepseek.requestBody({ ...base, effort: 'medium' })).toMatchObject({ reasoning_effort: 'high' });
    expect(deepseek.requestBody({ ...base, effort: 'off' })).toMatchObject({ thinking: { type: 'disabled' } });
    expect(deepseek.requestBody({ ...base, effort: 'off' })).not.toHaveProperty('reasoning_effort');
  });

  it('adds response_format: { type: "json_object" } for supported presets and keeps prompt instruction', () => {
    const openrouter = new OpenAICompatibleAdapter({ provider: 'openrouter', apiKey: KEY });
    const openrouterBody = openrouter.requestBody({ ...base, responseSchema: { type: 'object' } });
    const openrouterMessages = openrouterBody.messages as Array<{ role: string; content: string }>;
    expect(openrouterMessages[0]?.content).toContain('{"type":"object"}');
    expect(openrouterBody).toMatchObject({ response_format: { type: 'json_object' } });

    const deepseek = new OpenAICompatibleAdapter({ provider: 'deepseek', apiKey: KEY });
    expect(deepseek.requestBody({ ...base, responseSchema: { type: 'object' } })).toMatchObject({
      response_format: { type: 'json_object' },
    });

    const nvidia = new OpenAICompatibleAdapter({ provider: 'nvidia', apiKey: KEY });
    expect(nvidia.requestBody({ ...base, responseSchema: { type: 'object' } })).not.toHaveProperty('response_format');
  });

  it('retries silently without response_format when server rejects with 400', async () => {
    let attempts = 0;
    const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      attempts++;
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.response_format) {
        return jsonResponse({ error: { message: 'unsupported parameter: response_format' } }, 400);
      }
      return okStream();
    });

    const adapter = new OpenAICompatibleAdapter({ provider: 'openrouter', apiKey: KEY, fetch });
    const result = await collectText(adapter.stream({ ...base, responseSchema: { type: 'object' } }));
    expect(attempts).toBe(2);
    expect(result.text).toBe('Hello');
  });

  it('does not retry an unrelated 400 and keeps its message', async () => {
    let attempts = 0;
    const fetch = vi.fn(async () => {
      attempts++;
      return jsonResponse({ error: { message: 'context length exceeded' } }, 400);
    });
    const adapter = new OpenAICompatibleAdapter({ provider: 'openrouter', apiKey: KEY, fetch });
    const failure = await failureOf(collectText(adapter.stream({ ...base, responseSchema: { type: 'object' } })));
    expect(attempts).toBe(1);
    expect(failure.message).toContain('context length exceeded');
  });

  it('treats r1 as a reasoning marker only as its own token', async () => {
    const { isCompatibleReasoningModel } = await import('../effort.js');
    expect(isCompatibleReasoningModel('openrouter', 'deepseek/deepseek-r1')).toBe(true);
    expect(isCompatibleReasoningModel('nvidia', 'deepseek-ai/deepseek-r1-distill-qwen-32b')).toBe(true);
    expect(isCompatibleReasoningModel('xai', 'grok-4-fast-r1x')).toBe(false);
    expect(isCompatibleReasoningModel('custom', 'mistral-large-2411')).toBe(false);
  });

  it('sends a stable x-opencode-session header to OpenCode only', async () => {
    const { fetch, calls } = mockFetch(okStream());
    const adapter = new OpenAICompatibleAdapter({ provider: 'opencode-go', apiKey: KEY, fetch });
    await collectText(adapter.stream(base));
    await collectText(adapter.stream(base));
    const session = calls[0]?.headers['x-opencode-session'];
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]?.headers['x-opencode-session']).toBe(session);

    const other = mockFetch(okStream());
    await collectText(new OpenAICompatibleAdapter({ provider: 'nvidia', apiKey: KEY, fetch: other.fetch }).stream(base));
    expect(other.calls[0]?.headers).not.toHaveProperty('x-opencode-session');
  });

  it('requires a base URL for custom and allows a keyless local server', async () => {
    expect(() => new OpenAICompatibleAdapter({ provider: 'custom' })).toThrow('requires a base URL');
    const { fetch, calls } = mockFetch(okStream());
    const adapter = new OpenAICompatibleAdapter({ provider: 'custom', baseUrl: 'http://localhost:11434/v1/', fetch });
    await collectText(adapter.stream(base));
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]?.headers).not.toHaveProperty('authorization');
  });

  it('rejects native providers', () => {
    expect(() => new OpenAICompatibleAdapter({ provider: 'anthropic', apiKey: KEY })).toThrow('not an OpenAI-compatible');
  });

  it('turns HTTP errors into LlmFailure codes with the key redacted', async () => {
    const quota = mockFetch(jsonResponse({ error: { message: `insufficient credits for key ${KEY}` } }, 402));
    const failure = await failureOf(collectText(new OpenAICompatibleAdapter({ provider: 'openrouter', apiKey: KEY, fetch: quota.fetch }).stream(base)));
    expect(failure.code).toBe('QUOTA');
    expect(failure.message).not.toContain(KEY);
    expect(failure.message).toContain('insufficient credits');

    const limited = mockFetch(jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '3' }));
    const rateLimit = await failureOf(collectText(new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY, fetch: limited.fetch }).stream(base)));
    expect(rateLimit.code).toBe('RATE_LIMIT');
    expect(rateLimit.retryAfterMs).toBe(3000);

    const auth = mockFetch(textResponse('unauthorized', 401));
    expect((await failureOf(collectText(new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY, fetch: auth.fetch }).stream(base)))).code).toBe(
      'INVALID_CREDENTIAL',
    );
  });

  it('reports a network failure, an abort and a stream cut mid-answer', async () => {
    const offline = mockFetch(() => {
      throw new TypeError(`fetch failed for ${KEY}`);
    });
    const network = await failureOf(collectText(new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY, fetch: offline.fetch }).stream(base)));
    expect(network.code).toBe('NETWORK');
    expect(network.message).not.toContain(KEY);

    const controller = new AbortController();
    controller.abort();
    const aborted = await failureOf(
      collectText(new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY, fetch: mockFetch(okStream()).fetch }).stream({ ...base, signal: controller.signal })),
    );
    expect(aborted.code).toBe('ABORTED');

    const cut = mockFetch(sseResponse([{ choices: [{ delta: { content: 'half' } }] }]));
    const early = await failureOf(collectText(new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY, fetch: cut.fetch }).stream(base)));
    expect(early.code).toBe('NETWORK');
  });

  it('surfaces an error event inside the stream', async () => {
    const { fetch } = mockFetch(sseResponse([{ error: { message: `overloaded ${KEY}`, code: 429 } }]));
    const failure = await failureOf(collectText(new OpenAICompatibleAdapter({ provider: 'openrouter', apiKey: KEY, fetch }).stream(base)));
    expect(failure.code).toBe('RATE_LIMIT');
    expect(failure.message).not.toContain(KEY);
  });
});

describe('parseSseChunk', () => {
  it('splits complete events, skips comments and keeps the partial rest', () => {
    const { events, rest } = parseSseChunk(': ping\n\ndata: {"a":1}\n\nevent: x\ndata: two\r\n\r\ndata: par');
    expect(events).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'x', data: 'two' },
    ]);
    expect(rest).toBe('data: par');
  });

  it('gives GLM thinking "on" the default thinking headroom so the answer is not truncated', () => {
    const zaiCoding = new OpenAICompatibleAdapter({ provider: 'zai-coding', apiKey: KEY });
    const on = zaiCoding.requestedOutputTokens({ model: 'glm-5.3', effort: 'on', maxOutputTokens: 2048 });
    const off = zaiCoding.requestedOutputTokens({ model: 'glm-5.3', effort: 'off', maxOutputTokens: 2048 });
    expect(on).toBeGreaterThanOrEqual(2048 + 8192);
    expect(off).toBe(2048);
    const body = zaiCoding.requestBody({ ...base, model: 'glm-5.3', effort: 'on', maxOutputTokens: 2048 });
    expect(body.max_tokens).toBe(on);
  });

  describe('per-call thinking off (ADR-0013 empty-reply retry)', () => {
    it('sends GLM thinking disabled over the configured effort, without thinking headroom', async () => {
      const { fetch, calls } = mockFetch(okStream());
      const adapter = new OpenAICompatibleAdapter({ provider: 'zai-coding', apiKey: KEY, fetch });
      await collectText(adapter.stream({ ...base, model: 'glm-5.3', effort: 'on', thinking: 'off' }));
      expect(calls[0]?.body).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 100 });
      // Without the override the configured effort still applies.
      expect(adapter.requestBody({ ...base, model: 'glm-5.3', effort: 'on' })).toMatchObject({ thinking: { type: 'enabled' } });
      expect(adapter.requestBody({ ...base, model: 'glm-5.3', thinking: 'off' })).toMatchObject({ thinking: { type: 'disabled' } });
    });

    it('sends the lowest reasoning_effort to an OpenAI-style reasoning model', () => {
      const xai = new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY });
      expect(xai.requestBody({ ...base, effort: 'high', thinking: 'off' })).toMatchObject({ reasoning_effort: 'low' });
      const openrouter = new OpenAICompatibleAdapter({ provider: 'openrouter', apiKey: KEY });
      expect(openrouter.requestBody({ ...base, model: 'deepseek/deepseek-r1', thinking: 'off' })).toMatchObject({
        reasoning_effort: 'low',
      });
    });

    it('sends nothing extra where the call would not think, and ignores it on styles without a switch', () => {
      const xai = new OpenAICompatibleAdapter({ provider: 'xai', apiKey: KEY });
      expect(xai.requestBody({ ...base, thinking: 'off' })).not.toHaveProperty('reasoning_effort');
      expect(xai.requestBody({ ...base, effort: 'off', thinking: 'off' })).not.toHaveProperty('reasoning_effort');
      const xiaomi = new OpenAICompatibleAdapter({ provider: 'xiaomi', apiKey: KEY });
      const body = xiaomi.requestBody({ ...base, effort: 'high', thinking: 'off' });
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('thinking');
    });

    it('turns DeepSeek thinking off for the retry, whatever effort is configured', () => {
      const deepseek = new OpenAICompatibleAdapter({ provider: 'deepseek', apiKey: KEY });
      const body = deepseek.requestBody({ ...base, model: 'deepseek-v4-pro', effort: 'high', thinking: 'off' });
      expect(body).toMatchObject({ thinking: { type: 'disabled' } });
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body.max_tokens).toBe(100);
    });
  });
});

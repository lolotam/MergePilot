import { describe, expect, it } from 'vitest';
import { ApiError } from '@google/genai';
import { Secret } from '../../credentials/secret.js';
import { LlmFailure } from '../../llm/failure.js';
import { GeminiAdapter } from './adapter.js';
import { collectChunks, FAKE_KEY, makeFakeClient } from './adapter.fixtures.js';

describe('GeminiAdapter - error handling and aborts', () => {
  it('maps 400 "API key not valid" to INVALID_CREDENTIAL', async () => {
    const { client } = makeFakeClient(() => {
      throw new ApiError({
        status: 400,
        message: 'API key not valid. Please pass a valid API key.',
      });
    });

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('INVALID_CREDENTIAL');
      expect(failure.provider).toBe('gemini');
      expect(failure.status).toBe(400);
      return true;
    });
  });

  it('maps 400 with other wording to BAD_REQUEST via failureFromHttp', async () => {
    const { client } = makeFakeClient(() => {
      throw new ApiError({
        status: 400,
        message: 'Invalid argument: invalid parameter value',
      });
    });

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('BAD_REQUEST');
      expect(failure.provider).toBe('gemini');
      expect(failure.status).toBe(400);
      return true;
    });
  });

  it('maps 429 to RATE_LIMIT via failureFromHttp', async () => {
    const { client } = makeFakeClient(() => {
      throw new ApiError({
        status: 429,
        message: 'Resource exhausted: rate limit exceeded',
      });
    });

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('RATE_LIMIT');
      expect(failure.provider).toBe('gemini');
      expect(failure.status).toBe(429);
      return true;
    });
  });

  it('maps 500 to SERVER via failureFromHttp', async () => {
    const { client } = makeFakeClient(() => {
      throw new ApiError({
        status: 500,
        message: 'Internal server error',
      });
    });

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('SERVER');
      expect(failure.provider).toBe('gemini');
      expect(failure.status).toBe(500);
      return true;
    });
  });

  it('maps aborted signal before stream to ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();

    const { client } = makeFakeClient([{ text: 'Never reached' }]);
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
        signal: controller.signal,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('ABORTED');
      expect(failure.provider).toBe('gemini');
      return true;
    });
  });

  it('maps abort during streaming iteration to ABORTED', async () => {
    const controller = new AbortController();
    const { client } = makeFakeClient(async function* () {
      yield { text: 'Part 1' };
      controller.abort();
      yield { text: 'Part 2' };
    });

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
        signal: controller.signal,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('ABORTED');
      expect(failure.provider).toBe('gemini');
      return true;
    });
  });

  it('maps AbortError thrown by client to ABORTED', async () => {
    const { client } = makeFakeClient(() => {
      const error = new Error('The user aborted a request.');
      error.name = 'AbortError';
      throw error;
    });

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('ABORTED');
      expect(failure.provider).toBe('gemini');
      return true;
    });
  });

  it('maps generic error without status to UNKNOWN', async () => {
    const { client } = makeFakeClient(() => {
      throw new Error('Connection reset by peer');
    });

    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, client });

    await expect(
      collectChunks(adapter, {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 10,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmFailure);
      const failure = err as LlmFailure;
      expect(failure.code).toBe('UNKNOWN');
      expect(failure.provider).toBe('gemini');
      expect(failure.message).toBe('Connection reset by peer');
      return true;
    });
  });
});

describe('GeminiAdapter key redaction', () => {
  it('never puts the API key into a failure message', async () => {
    const key = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123';
    const client = {
      models: {
        generateContentStream: async () => {
          throw Object.assign(new Error(`HTTP 500 for https://example.test/v1?key=${key}`), { status: 500 });
        },
      },
    };
    const adapter = new GeminiAdapter({ apiKey: new Secret(key), client: client as never });
    const run = async () => {
      for await (const _chunk of adapter.stream({ model: 'm', messages: [], maxOutputTokens: 10 })) {
        // drain
      }
    };
    await expect(run()).rejects.toSatisfy((e: unknown) => e instanceof Error && !e.message.includes(key));
  });
});

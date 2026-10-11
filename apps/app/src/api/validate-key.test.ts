import { describe, it, expect, vi } from 'vitest';
import { validateKey, ValidateKeyError } from './validate-key.js';

describe('validateKey', () => {
  const fakeKey = 'sk-test-secret-key-12345';

  it('validates Anthropic key with GET /v1/models, x-api-key and anthropic-version', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://api.anthropic.com/v1/models');
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(fakeKey);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await expect(validateKey('anthropic', fakeKey, fetchFn as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('validates OpenAI key with GET /v1/models and Bearer token', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/models');
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${fakeKey}`);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await expect(validateKey('openai', fakeKey, fetchFn as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('validates Gemini key with GET https://generativelanguage.googleapis.com/v1beta/models and x-goog-api-key', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe(fakeKey);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });

    await expect(validateKey('gemini', fakeKey, fetchFn as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws on 401 unauthorized and never leaks the key in the message', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    });

    let caught: Error | null = null;
    try {
      await validateKey('anthropic', fakeKey, fetchFn as unknown as typeof fetch);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(ValidateKeyError);
    expect(caught?.message.toLowerCase()).toContain('invalid');
    expect(caught?.message).not.toContain(fakeKey);
  });

  it('throws on 403 forbidden and never leaks the key in the message', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    });

    let caught: Error | null = null;
    try {
      await validateKey('openai', fakeKey, fetchFn as unknown as typeof fetch);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(ValidateKeyError);
    expect(caught?.message.toLowerCase()).toContain('invalid');
    expect(caught?.message).not.toContain(fakeKey);
  });

  it('throws "could not verify" on network error and never leaks the key in the message', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error(`Connection timeout with key ${fakeKey}`);
    });

    let caught: Error | null = null;
    try {
      await validateKey('gemini', fakeKey, fetchFn as unknown as typeof fetch);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).toBe('could not verify');
    expect(caught?.message).not.toContain(fakeKey);
  });

  it('throws "could not verify" on 500 server error', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response('Internal Server Error', { status: 500 });
    });

    let caught: Error | null = null;
    try {
      await validateKey('anthropic', fakeKey, fetchFn as unknown as typeof fetch);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).toBe('could not verify');
  });

  it('rejects empty or whitespace-only API keys without network calls', async () => {
    const fetchFn = vi.fn();
    await expect(validateKey('openai', '   ', fetchFn as unknown as typeof fetch)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

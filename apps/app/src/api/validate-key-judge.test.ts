import { describe, expect, it, vi } from 'vitest';
import { validateKey, ValidateKeyError } from './validate-key.js';

const key = ['tk', 'judge', 'w3'.repeat(8)].join('-');
const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

describe('validateKey — Jev-only key types (ADR-0015) and Vercel AI Gateway', () => {
  it('proves a TypeSafe key with one tiny noul question on the fixed endpoint', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => reply(200, { answers: { ok: { type: 'noul', noul: 1 } }, usage: {} }));
    await expect(validateKey('typesafe', key, fetchFn)).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as { model: string; questions: object };
    expect(body.model).toBe('jev-latest');
  });

  it('rejects a key the provider refuses, without echoing it', async () => {
    const fetchFn = vi.fn(async () => reply(401, { error: { message: `bad ${key}` } }));
    const error = (await validateKey('typesafe', key, fetchFn).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(ValidateKeyError);
    expect(error.message).toBe('invalid key for typesafe');
    expect(error.message).not.toContain(key);
  });

  it('proves a Vercel AI Gateway key as a review key on the fixed models endpoint, not the judge', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => reply(200, { data: [] }));
    await expect(validateKey('vercel-gateway', key, fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://ai-gateway.vercel.sh/v1/models');
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${key}`);

    const refused = vi.fn(async () => reply(401, { error: { message: `bad ${key}` } }));
    const error = (await validateKey('vercel-gateway', key, refused).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(ValidateKeyError);
    expect(error.message).toBe('invalid key for vercel-gateway');
  });

  it('accepts a key that authenticated even when the test question was refused (422)', async () => {
    const fetchFn = vi.fn(async () => reply(422, { detail: [{ loc: ['body', 'model'], msg: 'unknown model' }] }));
    await expect(validateKey('typesafe', key, fetchFn)).resolves.toBeUndefined();
  });
});

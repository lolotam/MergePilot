import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_MODELS_TTL_MS, listAntigravityModels, parseAvailableModels, resetAntigravityModelCache, staticAntigravityModels } from './models.js';

const credential = { access: ['fake', 'access'].join('-'), projectId: 'project-1' };

beforeEach(() => resetAntigravityModelCache());

describe('parseAvailableModels', () => {
  it('keeps chat models from a map keyed by id, with their efforts', () => {
    const models = parseAvailableModels({
      models: {
        'gemini-3.1-pro': { displayName: 'Gemini 3.1 Pro', maxTokens: 1_048_576 },
        'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6' },
        'gpt-oss-120b': {},
        'gemini-3-pro-image': {},
        chat_20706: {},
      },
    });
    expect(models.map((model) => model.id)).toEqual(['claude-sonnet-4-6', 'gemini-3.1-pro', 'gpt-oss-120b']);
    expect(models[1]).toMatchObject({ name: 'Gemini 3.1 Pro', contextWindow: 1_048_576, efforts: ['minimal', 'low', 'medium', 'high'] });
    expect(models[0]!.efforts).toEqual(['off', 'low', 'medium', 'high']);
    expect(models[2]!.efforts).toEqual([]);
  });

  it('accepts an array of entries', () => {
    expect(parseAvailableModels({ models: [{ id: 'gemini-3.8-flash' }, { name: 'models/claude-opus-4-6' }] }).map((m) => m.id))
      .toEqual(['claude-opus-4-6', 'gemini-3.8-flash']);
  });
});

describe('listAntigravityModels', () => {
  it('asks for the project and caches the answer for four hours', async () => {
    let now = 1_000;
    const fetchMock = vi.fn(async () => Response.json({ models: { 'gemini-3.1-pro': {} } }));
    const options = { fetch: fetchMock, now: () => now };
    expect((await listAntigravityModels(credential, options)).map((m) => m.id)).toEqual(['gemini-3.1-pro']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels');
    expect(JSON.parse(String(init.body))).toEqual({ project: 'project-1' });

    now += ANTIGRAVITY_MODELS_TTL_MS - 1;
    await listAntigravityModels(credential, options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 2;
    await listAntigravityModels(credential, options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels the body of a refused model-list request and serves the static list', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('denied')); }, cancel });
    const fetchMock = vi.fn(async () => new Response(body, { status: 403 }));
    expect(await listAntigravityModels(credential, { fetch: fetchMock })).toEqual(staticAntigravityModels());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good list when a refresh fails, and falls back to the static list without one', async () => {
    let now = 0;
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => Response.json({ models: { 'claude-opus-4-6': {} } }))
      .mockImplementation(async () => new Response('denied', { status: 403 }));
    await listAntigravityModels(credential, { fetch: fetchMock, now: () => now });
    now += ANTIGRAVITY_MODELS_TTL_MS + 1;
    expect((await listAntigravityModels(credential, { fetch: fetchMock, now: () => now })).map((m) => m.id)).toEqual(['claude-opus-4-6']);

    const other = { ...credential, projectId: 'project-2' };
    expect(await listAntigravityModels(other, { fetch: fetchMock, now: () => now })).toEqual(staticAntigravityModels());
  });
});

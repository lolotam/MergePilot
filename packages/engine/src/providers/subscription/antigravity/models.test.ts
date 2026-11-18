import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_MODELS_TTL_MS, listAntigravityModels, parseAvailableModels, resetAntigravityModelCache, staticAntigravityModels } from './models.js';

import { jsonResponse, mockFetch, textResponse } from '../../fetch-mock.fixtures.js';

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

it('promotes a strict result to last good only after the caller accepts it', async () => {
  const { fetch, calls } = mockFetch(
    jsonResponse({ models: { 'gemini-3.1-pro': {} } }),
    jsonResponse({ models: { 'models/gemini-3.8-flash': {} } }),
    jsonResponse({ models: {} }),
    () => textResponse('denied', 403),
  );
  const commits: Array<() => void> = [];
  const options = { fetch, now: () => 100, strictRefresh: true, deferCacheWrite: (commit: () => void) => commits.push(commit) };
  expect(await listAntigravityModels(credential, { fetch, now: options.now })).toMatchObject([{ id: 'gemini-3.1-pro' }]);
  expect(await listAntigravityModels(credential, options)).toMatchObject([{ id: 'gemini-3.8-flash' }]);
  expect(await listAntigravityModels(credential, { fetch, now: options.now })).toMatchObject([{ id: 'gemini-3.1-pro' }]);
  expect(commits).toHaveLength(1);
  commits[0]?.();
  expect(await listAntigravityModels(credential, { fetch, now: options.now })).toMatchObject([{ id: 'gemini-3.8-flash' }]);
  expect(await listAntigravityModels(credential, options)).toEqual([]);
  expect(commits).toHaveLength(1);
  const expired = () => 100 + ANTIGRAVITY_MODELS_TTL_MS + 1;
  expect(await listAntigravityModels(credential, { fetch, now: expired })).toMatchObject([{ id: 'gemini-3.8-flash' }]);
  expect(calls).toHaveLength(4);
});

it('keeps the latest-started accepted strict result for a shared project', async () => {
  const older = Promise.withResolvers<Response>();
  const { fetch, calls } = mockFetch(
    () => older.promise,
    jsonResponse({ models: { 'gemini-3.8-flash': {} } }),
  );
  const commits: Array<() => void> = [];
  const options = { fetch, strictRefresh: true, deferCacheWrite: (commit: () => void) => commits.push(commit) };
  const pending = listAntigravityModels(credential, options);
  await listAntigravityModels(credential, options);
  commits[0]?.();
  older.resolve(jsonResponse({ models: { 'gemini-3.1-pro': {} } }));
  await pending;
  expect(commits).toHaveLength(2);
  commits[1]?.();
  expect(await listAntigravityModels(credential, { fetch })).toMatchObject([{ id: 'gemini-3.8-flash' }]);
  expect(calls).toHaveLength(2);
});

it('publishes an accepted strict read even when a later ordinary read finishes first', async () => {
  const strict = Promise.withResolvers<Response>();
  const { fetch } = mockFetch(() => strict.promise, jsonResponse({ models: { 'gemini-3.1-pro': {} } }));
  const commits: Array<() => void> = [];
  const pending = listAntigravityModels(credential, {
    fetch, strictRefresh: true, deferCacheWrite: (commit) => commits.push(commit),
  });
  expect(await listAntigravityModels(credential, { fetch })).toMatchObject([{ id: 'gemini-3.1-pro' }]);
  strict.resolve(jsonResponse({ models: { 'gemini-3.8-flash': {} } }));
  await pending;
  expect(commits).toHaveLength(1);
  commits[0]?.();
  expect(await listAntigravityModels(credential, { fetch })).toMatchObject([{ id: 'gemini-3.8-flash' }]);
});

it.each(['refresh', 'evict-other', 'evict-target'] as const)('keeps catalog ordering under cache pressure: %s', async (operation) => {
  const stale = Promise.withResolvers<Response>();
  const pending = listAntigravityModels(credential, { now: () => 0, fetch: () => stale.promise });
  const newer = mockFetch(jsonResponse({ models: { 'gemini-3.8-flash': {} } })).fetch;
  await listAntigravityModels(credential, { now: () => 1, fetch: newer });
  for (let i = 0; i < 499; i++) {
    await listAntigravityModels({ ...credential, projectId: 'fill-' + i }, { now: () => 1, fetch: newer });
  }
  let acceptStrict: (() => void) | undefined;
  if (operation === 'evict-other') {
    // Keep the target recently used without refreshing its TTL or writing a new catalog.
    await listAntigravityModels(credential, { now: () => 2, fetch: newer });
    await listAntigravityModels(credential, {
      now: () => 2, strictRefresh: true,
      fetch: mockFetch(jsonResponse({ models: { 'claude-opus-4-6': {} } })).fetch,
      deferCacheWrite: (commit) => { acceptStrict = commit; },
    });
  }
  const afterExpiry = () => ANTIGRAVITY_MODELS_TTL_MS + 2;
  const touched = { ...credential, projectId: operation === 'refresh' ? 'fill-0' : 'new-project' };
  await listAntigravityModels(touched, { now: afterExpiry, fetch: newer });
  acceptStrict?.();
  stale.resolve(jsonResponse({ models: { 'gemini-3.1-pro': {} } }));
  await pending;
  const refused = mockFetch(() => textResponse('denied', 403)).fetch;
  const result = await listAntigravityModels(credential, { now: afterExpiry, fetch: refused });
  if (operation === 'evict-target') expect(result).toEqual(staticAntigravityModels());
  else expect(result).toMatchObject([{ id: operation === 'evict-other' ? 'claude-opus-4-6' : 'gemini-3.8-flash' }]);
  if (operation === 'evict-other') {
    const oldest = { ...credential, projectId: 'fill-0' };
    const retained = { ...credential, projectId: 'fill-1' };
    expect(await listAntigravityModels(oldest, { now: afterExpiry, fetch: refused })).toEqual(staticAntigravityModels());
    expect(await listAntigravityModels(retained, { now: afterExpiry, fetch: refused })).toMatchObject([{ id: 'gemini-3.8-flash' }]);
  }
});

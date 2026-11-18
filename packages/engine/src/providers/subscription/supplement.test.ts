import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Secret } from '../../credentials/secret.js';
import { encodeSubscription } from '../../credentials/subscription.js';
import { collectText } from '../../llm/collect.js';
import { listCodexModelsWithApiKey } from '../catalog.js';
import { jsonResponse, mockFetch, textResponse } from '../fetch-mock.fixtures.js';
import { SubscriptionAdapter, subscriptionModels } from './adapter.js';
import { supplementaryModel, supplementCatalog } from './supplement.js';

const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`;
const refresh = ['opaque', 'refresh', 'value'].join('-');
const subscriptionKey = new Secret(encodeSubscription('openai', { type: 'oauth', access, refresh, expires: Date.now() + 3_600_000, accountId: 'account-test' }));
const apiKey = new Secret(['s', 'k-', 'y'.repeat(24)].join(''));
const bundled = subscriptionModels('openai');

function sse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function answer(): Response {
  const item = { id: 'msg-test', type: 'message', role: 'assistant', content: [] };
  const done = { ...item, content: [{ type: 'output_text', text: 'OK' }] };
  return sse([
    { type: 'response.created', response: { id: 'resp-test', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { id: 'resp-test', status: 'completed', output: [done], usage: { input_tokens: 10, output_tokens: 2 } } },
  ]);
}

afterEach(() => vi.unstubAllGlobals());

describe('Codex models listed by the OpenAI API key', () => {
  it('builds an unlisted Codex-family model from the bundled one and refuses other ids and providers', () => {
    const model = supplementaryModel('openai', 'gpt-99-future');
    expect(model).toMatchObject({ id: 'gpt-99-future', name: 'gpt-99-future' });
    const template = bundled.reduce((best, entry) => ((entry.contextWindow ?? 0) > (best.contextWindow ?? 0) ? entry : best));
    expect(model?.contextWindow).toBe(template.contextWindow);
    for (const id of ['gpt-4o', 'o3', 'text-embedding-3-small', 'gpt-5-image', 'gpt-realtime', 'whisper-1']) {
      expect(supplementaryModel('openai', id)).toBeUndefined();
    }
    expect(supplementaryModel('xai', 'gpt-99-future')).toBeUndefined();
    expect(supplementaryModel('anthropic', 'gpt-99-future')).toBeUndefined();
  });

  it('adds only missing Codex-family ids, once each, and keeps the bundled entries untouched', () => {
    const first = bundled[0]!;
    const merged = supplementCatalog(bundled, [
      { id: first.id, name: first.id, efforts: [] },
      { id: 'gpt-99-future', name: 'gpt-99-future', efforts: [] },
      { id: 'gpt-99-future', name: 'gpt-99-future', efforts: [] },
      { id: 'gpt-4.1', name: 'gpt-4.1', efforts: [] },
    ]);
    expect(merged.slice(0, bundled.length)).toEqual(bundled);
    expect(merged.slice(bundled.length).map((entry) => entry.id)).toEqual(['gpt-99-future']);
    expect(merged.at(-1)?.efforts.length).toBeGreaterThan(0);
  });

  it('lists the API key with a Bearer token and returns the sign-in catalog plus its new models', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: [{ id: 'gpt-99-future' }, { id: 'gpt-4o' }] }));
    const result = await listCodexModelsWithApiKey(subscriptionKey, apiKey, { fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${apiKey.reveal()}`);
    expect(result.merged).toBe(true);
    const ids = result.models.map((entry) => entry.id);
    expect(ids).toContain('gpt-99-future');
    expect(ids).not.toContain('gpt-4o');
    for (const entry of bundled) expect(ids).toContain(entry.id);
    expect(JSON.stringify(result)).not.toContain(apiKey.reveal());
  });

  it('keeps the sign-in catalog when the key is refused, without leaking the key', async () => {
    const { fetch } = mockFetch(textResponse(`denied ${apiKey.reveal()}`, 401));
    const result = await listCodexModelsWithApiKey(subscriptionKey, apiKey, { fetch });
    expect(result.merged).toBe(false);
    expect(result.models.map((entry) => entry.id)).toEqual(bundled.map((entry) => entry.id).sort((a, b) => a.localeCompare(b)));
    expect(JSON.stringify(result)).not.toContain(apiKey.reveal());
  });

  it('rethrows a cancellation instead of answering from the bundled catalog', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      init?.signal?.throwIfAborted();
      return jsonResponse({ data: [] });
    };
    await expect(listCodexModelsWithApiKey(subscriptionKey, apiKey, { fetch, signal: controller.signal })).rejects.toThrow();
  });

  it('rethrows a fetch that aborts on its own, but still falls back for an ordinary failure', async () => {
    const aborting = async (): Promise<Response> => { throw new DOMException('aborted', 'AbortError'); };
    await expect(listCodexModelsWithApiKey(subscriptionKey, apiKey, { fetch: aborting })).rejects.toMatchObject({ code: 'ABORTED' });
    const { fetch } = mockFetch(textResponse('down', 503));
    await expect(listCodexModelsWithApiKey(subscriptionKey, apiKey, { fetch })).resolves.toMatchObject({ merged: false });
  });

  it('streams a call for an API-listed Codex id and sends that id, while an unknown Grok id still fails', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = init?.body;
      sent = JSON.parse(typeof body === 'string' ? body : zstdDecompressSync(body as Uint8Array).toString('utf8')) as Record<string, unknown>;
      return answer();
    }));
    const request = (model: string) => ({ model, messages: [{ role: 'user' as const, content: 'Say OK' }], maxOutputTokens: 1024 });
    const adapter = new SubscriptionAdapter('openai', subscriptionKey);
    await expect(collectText(adapter.stream(request('gpt-99-future')))).resolves.toMatchObject({ text: 'OK' });
    expect(sent.model).toBe('gpt-99-future');
    expect(adapter.requestedOutputTokens({ model: 'gpt-99-future', maxOutputTokens: 1024 })).toBeGreaterThan(0);

    const grok = new SubscriptionAdapter('xai', new Secret(encodeSubscription('xai', { type: 'oauth', access, refresh, expires: Date.now() + 3_600_000 })));
    await expect(collectText(grok.stream(request('gpt-99-future')))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

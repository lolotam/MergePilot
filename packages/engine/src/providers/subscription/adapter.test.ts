import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSubscription } from '../../credentials/subscription.js';
import { Secret } from '../../credentials/secret.js';
import { redactSecrets } from '../../security/redact.js';
import { collectText } from '../../llm/collect.js';
import { createAdapter } from '../factory.js';
import { listModels } from '../catalog.js';
import { SubscriptionAdapter, subscriptionModels } from './adapter.js';

const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`;
const refresh = ['opaque', 'refresh', 'value'].join('-');
const claudeAccess = ['sk', 'ant', 'oat01', 'test-only-access'].join('-');
const request = (model: string) => ({ model, messages: [{ role: 'system' as const, content: 'Review only' }, { role: 'user' as const, content: 'Say OK' }], maxOutputTokens: 1024 });
const secretFor = (provider: 'openai' | 'anthropic' | 'xai') => new Secret(encodeSubscription(provider, { type: 'oauth', access: provider === 'anthropic' ? claudeAccess : access, refresh, expires: Date.now() + 3_600_000, accountId: 'account-test' }));
const sse = (events: Record<string, unknown>[]) => new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

afterEach(() => vi.unstubAllGlobals());
describe('subscription model protocols', () => {
  it('redacts malformed credential envelopes without throwing from the redaction path', () => {
    const value = 'mergepilot:oauth:v1:invalid-envelope';
    const result = redactSecrets(`Provider echoed ${value}`, [new Secret(value)]);
    expect(result.text).not.toContain(value);
    expect(result.text).toContain('[REDACTED:known]');
  });
  it.each(['openai', 'anthropic', 'xai'] as const)('routes %s subscription credentials to their subscription protocol and redacts individual tokens', async (provider) => {
    const secret = secretFor(provider);
    expect(createAdapter(provider, secret)).toBeInstanceOf(SubscriptionAdapter);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const catalog = await listModels(provider, secret);
    expect(catalog.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const token = provider === 'anthropic' ? claudeAccess : access;
    const redacted = redactSecrets(`access=${token}; refresh=${refresh}`, [secret]).text;
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain(refresh);
  });

  it.each(['openai', 'xai'] as const)('streams %s Responses API text and usage with bearer authentication', async (provider) => {
    const model = subscriptionModels(provider)[0]!.id;
    const item = { id: 'msg-test', type: 'message', role: 'assistant', content: [] };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain(provider === 'openai' ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://api.x.ai/v1/responses');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`);
      expect(String(init?.body)).not.toContain(refresh);
      return sse([
        { type: 'response.created', response: { id: 'resp-test', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'OK' },
        { type: 'response.output_item.done', output_index: 0, item: { ...item, content: [{ type: 'output_text', text: 'OK' }] } },
        { type: 'response.completed', response: { id: 'resp-test', status: 'completed', output: [{ ...item, content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await collectText(new SubscriptionAdapter(provider, secretFor(provider)).stream(request(model)));
    expect(result.text).toBe('OK');
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams Claude with OAuth bearer headers and no API-key header', async () => {
    const model = subscriptionModels('anthropic')[0]!.id;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${claudeAccess}`);
      expect(headers.get('x-api-key')).toBeNull();
      return sse([
        { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]);
    }));
    const result = await collectText(new SubscriptionAdapter('anthropic', secretFor('anthropic')).stream(request(model)));
    expect(result.text).toBe('OK');
    expect(result.usage?.outputTokens).toBe(2);
  });

  it.each(['openai', 'anthropic', 'xai'] as const)('classifies %s quota failures for fallback and redacts tokens echoed by the server', async (provider) => {
    const token = provider === 'anthropic' ? claudeAccess : access;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: `quota exceeded ${token} ${refresh}` } }, { status: 429 })));
    try {
      await collectText(new SubscriptionAdapter(provider, secretFor(provider)).stream(request(subscriptionModels(provider)[0]!.id)));
      expect.fail('Expected quota failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'QUOTA' });
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(refresh);
    }
  });
});

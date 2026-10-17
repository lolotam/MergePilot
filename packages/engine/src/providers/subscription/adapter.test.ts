import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSubscription } from '../../credentials/subscription.js';
import { Secret } from '../../credentials/secret.js';
import { redactSecrets } from '../../security/redact.js';
import { collectText } from '../../llm/collect.js';
import { createAdapter } from '../factory.js';
import { listModels } from '../catalog.js';
import { parseReviewAnswer } from '../../review/answer.js';
import { reviewJsonSchema } from '../../review/split.js';
import { SubscriptionAdapter, subscriptionModels } from './adapter.js';

const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`;
const refresh = ['opaque', 'refresh', 'value'].join('-');
const claudeAccess = ['sk', 'ant', 'oat01', 'test-only-access'].join('-');
const request = (model: string) => ({ model, messages: [{ role: 'system' as const, content: 'Review only' }, { role: 'user' as const, content: 'Say OK' }], maxOutputTokens: 1024 });
const secretFor = (provider: 'openai' | 'anthropic' | 'xai') => new Secret(encodeSubscription(provider, { type: 'oauth', access: provider === 'anthropic' ? claudeAccess : access, refresh, expires: Date.now() + 3_600_000, accountId: 'account-test' }));
const sse = (events: Record<string, unknown>[]) => new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

/** The JSON body of a request; the Codex transport sends it zstd-compressed. */
const requestJson = (body: unknown): unknown =>
  JSON.parse(typeof body === 'string' ? body : zstdDecompressSync(body as Uint8Array).toString('utf8'));

/** A Responses API stream that answers `OK` (Codex and Grok). */
function responsesReply(): Response {
  const item = { id: 'msg-test', type: 'message', role: 'assistant', content: [] };
  const done = { ...item, content: [{ type: 'output_text', text: 'OK' }] };
  return sse([
    { type: 'response.created', response: { id: 'resp-test', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { id: 'resp-test', status: 'completed', output: [done], usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } },
  ]);
}

/** Stubs fetch with a Responses API reply and returns the JSON body each request sent. */
function stubResponses(): { body: () => Record<string, unknown> } {
  let sent: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    sent = requestJson(init?.body) as Record<string, unknown>;
    return responsesReply();
  }));
  return { body: () => sent };
}

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

  it.each(['openai', 'xai'] as const)('streams %s Responses API text and usage with bearer authentication at the configured effort', async (provider) => {
    const model = subscriptionModels(provider).find((entry) => entry.efforts.includes('high'))!.id;
    let sent: { reasoning?: { effort?: string } } = {};
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain(provider === 'openai' ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://api.x.ai/v1/responses');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`);
      expect(String(init?.body)).not.toContain(refresh);
      sent = requestJson(init?.body) as typeof sent;
      return responsesReply();
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await collectText(new SubscriptionAdapter(provider, secretFor(provider)).stream({ ...request(model), effort: 'high' }));
    expect(result.text).toBe('OK');
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 });
    expect(sent.reasoning?.effort).toBe('high');
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

/** A Claude SSE reply that stops for `stopReason` after `text`, and the request body it answered. */
function stubClaude(text: string, stopReason: string, outputTokens: number): { body: () => Record<string, unknown> } {
  let sent: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sse([
      { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', content: [], model: 'm', stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } },
      { type: 'message_stop' },
    ]);
  }));
  return { body: () => sent };
}

/** The effort Claude runs at: a managed-effort model carries it on the last (system) message. */
function sentEffort(body: Record<string, unknown>): unknown {
  const messages = body.messages as { output_config?: { effort?: string } }[];
  return messages.at(-1)?.output_config?.effort ?? (body.output_config as { effort?: string } | undefined)?.effort;
}

// Regression: lolotam/MergePilot#143 and #144 (2026-10-16), claude-opus-5-5 at effort high on the
// subscription was sent max_tokens 4096 (8192 on the truncation retry) and its batches were cut.
describe('subscription output limit', () => {
  const review = (model: string, effort: string) => ({ ...request(model), effort, maxOutputTokens: 4096 });

  it.each([
    ['claude-opus-5-5', 'high', 4096 + 32768],
    ['claude-sonnet-5-5', 'medium', 4096 + 16384],
    ['claude-fable-5', 'max', 4096 + 32768],
  ])('sends %s at effort %s with thinking headroom on top of the answer', async (model, effort, limit) => {
    const reply = stubClaude('{"summary":"ok","findings":[]}', 'end_turn', 20);
    const adapter = new SubscriptionAdapter('anthropic', secretFor('anthropic'));

    await collectText(adapter.stream(review(model, effort)));

    expect(reply.body().max_tokens).toBe(limit);
    expect(sentEffort(reply.body())).toBe(effort);
    expect(adapter.requestedOutputTokens(review(model, effort))).toBe(limit);
  });

  it('reserves the high headroom for a managed-effort model that runs at high when no effort is set', () => {
    const adapter = new SubscriptionAdapter('anthropic', secretFor('anthropic'));
    expect(adapter.requestedOutputTokens({ model: 'claude-opus-5-5', maxOutputTokens: 4096 })).toBe(4096 + 32768);
  });

  it('prices a budget-thinking Claude model at the budget pi-ai adds itself', async () => {
    const reply = stubClaude('{"summary":"ok","findings":[]}', 'end_turn', 20);
    const adapter = new SubscriptionAdapter('anthropic', secretFor('anthropic'));

    await collectText(adapter.stream(review('claude-opus-4-5', 'medium')));

    expect(reply.body()).toMatchObject({ max_tokens: 4096 + 8192, thinking: { type: 'enabled', budget_tokens: 8192 } });
    expect(adapter.requestedOutputTokens(review('claude-opus-4-5', 'medium'))).toBe(4096 + 8192);
  });

  it('sizes a thinking-off retry the way it is sent, without the thinking budget', async () => {
    const reply = stubClaude('{"summary":"ok","findings":[]}', 'end_turn', 20);
    const adapter = new SubscriptionAdapter('anthropic', secretFor('anthropic'));
    const retry = { ...review('claude-opus-4-5', 'medium'), thinking: 'off' as const };

    await collectText(adapter.stream(retry));

    expect(reply.body()).toMatchObject({ max_tokens: 4096, thinking: { type: 'disabled' } });
    expect(adapter.requestedOutputTokens(retry)).toBe(4096);
  });

  it('keeps the bare answer budget for Codex, which pi-ai sends without an output limit', async () => {
    const reply = stubResponses();
    const model = subscriptionModels('openai').find((entry) => entry.efforts.includes('high'))!.id;
    const adapter = new SubscriptionAdapter('openai', secretFor('openai'));

    await collectText(adapter.stream(review(model, 'high')));

    expect(reply.body()).not.toHaveProperty('max_output_tokens');
    expect(adapter.requestedOutputTokens(review(model, 'high'))).toBe(4096);
  });

  it.each([
    ['grok-4.6', 'high', 4096 + 16384],
    ['grok-4.6', undefined, 4096 + 8192],
    ['grok-4.3', undefined, 4096],
  ])('sends Grok %s at effort %s a max_output_tokens with room to reason', async (model, effort, limit) => {
    const reply = stubResponses();
    const call = { ...request(model), maxOutputTokens: 4096, ...(effort ? { effort } : {}) };
    const adapter = new SubscriptionAdapter('xai', secretFor('xai'));

    await collectText(adapter.stream(call));

    expect(reply.body().max_output_tokens).toBe(limit);
    expect(adapter.requestedOutputTokens(call)).toBe(limit);
  });

  it('keeps the same output limit when the call carries a response schema', async () => {
    const reply = stubClaude('{"summary":"ok","findings":[]}', 'end_turn', 20);
    const call = { ...review('claude-opus-5-5', 'high'), responseSchema: reviewJsonSchema() };
    const adapter = new SubscriptionAdapter('anthropic', secretFor('anthropic'));

    await collectText(adapter.stream(call));

    expect(reply.body().max_tokens).toBe(4096 + 32768);
    expect(adapter.requestedOutputTokens(call)).toBe(4096 + 32768);
  });

  it('reports an answer cut at max_tokens as a truncated review, never as a finished one', async () => {
    stubClaude('{"summary":"cut', 'max_tokens', 4096 + 32768);

    const result = await collectText(new SubscriptionAdapter('anthropic', secretFor('anthropic')).stream(review('claude-opus-5-5', 'high')));
    const parsed = parseReviewAnswer(result.text, { finishReason: result.finishReason, outputTokens: result.usage?.outputTokens });

    expect(result.finishReason).toBe('max-tokens');
    expect(parsed).toMatchObject({ ok: false, code: 'truncated', error: 'truncated (finishReason: max-tokens, outputTokens: 36864)' });
  });
});

/** The text of every system block pi-ai sent to Claude. */
function sentSystem(body: Record<string, unknown>): string[] {
  return (body.system as { text: string }[]).map((block) => block.text);
}

// Regression: lolotam/MergePilot#150 and #152 (2026-10-17), claude-opus-5-5 on the subscription
// answered `{"summary": …}` without a findings key whenever it found nothing, so every clean
// review was disclosed as incomplete. Every other adapter sends the review JSON schema, where
// `findings` is required; this one dropped it.
describe('subscription response schema', () => {
  const SCHEMA_INSTRUCTION = 'Respond with a single JSON object matching this JSON schema:';

  it('sends Claude the review JSON schema, findings required, after the review system prompt', async () => {
    const reply = stubClaude('{"summary":"ok","findings":[]}', 'end_turn', 20);
    const schema = reviewJsonSchema();

    await collectText(new SubscriptionAdapter('anthropic', secretFor('anthropic'))
      .stream({ ...request('claude-opus-5-5'), responseSchema: schema }));

    const reviewSystem = sentSystem(reply.body()).find((text) => text.startsWith('Review only'));
    expect(reviewSystem).toBe(`Review only\n\n${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema)}`);
    expect(schema).toMatchObject({ required: ['summary', 'findings'] });
    expect(JSON.stringify(reply.body().messages)).toContain('"text":"Say OK"');
    expect(JSON.stringify(reply.body().messages)).not.toContain(SCHEMA_INSTRUCTION);
  });

  it('sends the schema as the system prompt when the call has none', async () => {
    const reply = stubClaude('{"summary":"ok","findings":[]}', 'end_turn', 20);
    const schema = reviewJsonSchema();

    await collectText(new SubscriptionAdapter('anthropic', secretFor('anthropic')).stream({
      model: 'claude-opus-5-5', maxOutputTokens: 1024, responseSchema: schema,
      messages: [{ role: 'user', content: 'Say OK' }],
    }));

    expect(sentSystem(reply.body())).toContain(`${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema)}`);
  });

  it('leaves the system prompt unchanged when the call asks for no schema', async () => {
    const reply = stubClaude('OK', 'end_turn', 2);

    await collectText(new SubscriptionAdapter('anthropic', secretFor('anthropic')).stream(request('claude-opus-5-5')));

    expect(sentSystem(reply.body())).toContain('Review only');
    expect(sentSystem(reply.body()).join('\n')).not.toContain(SCHEMA_INSTRUCTION);
  });

  it('sends Codex and Grok the schema in their instructions too', async () => {
    const reply = stubResponses();
    const schema = reviewJsonSchema();

    await collectText(new SubscriptionAdapter('xai', secretFor('xai')).stream({ ...request('grok-4.6'), responseSchema: schema }));

    expect(JSON.stringify(reply.body())).toContain(JSON.stringify(`${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema)}`).slice(1, -1));
  });
});

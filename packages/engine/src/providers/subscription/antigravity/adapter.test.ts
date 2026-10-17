import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../../../credentials/secret.js';
import { encodeSubscription } from '../../../credentials/subscription.js';
import { classifyFailure, type LlmFailure } from '../../../llm/failure.js';
import type { GenerateOptions, StreamChunk } from '../../../llm/types.js';
import { SubscriptionRefreshError } from '../refresh-error.js';
import { AntigravityAdapter } from './adapter.js';

const access = ['fake', 'antigravity', 'access'].join('-');
const secret = (projectId: string | undefined = 'project-1') => new Secret(encodeSubscription('google-antigravity', {
  type: 'oauth', access, refresh: ['fake', 'refresh'].join('-'), expires: Date.now() + 3_600_000,
  ...(projectId ? { projectId } : {}),
}));

const REFRESHED_ACCESS = 'fake-refreshed-access-token';
const DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const PROD = 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';

function sse(events: unknown[], split = 7): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // Small chunks so events and lines cross read boundaries.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += split) controller.enqueue(bytes.subarray(at, at + split));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const candidate = (parts: unknown[], finishReason?: string, usageMetadata?: unknown) => ({
  response: { candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) },
  traceId: 't1',
});

const options: GenerateOptions = {
  model: 'gemini-3.1-pro',
  messages: [
    { role: 'system', content: 'You review code.' },
    { role: 'user', content: 'Review this diff.' },
    { role: 'assistant', content: 'Earlier answer.' },
  ],
  maxOutputTokens: 1000,
  effort: 'high',
  temperature: 0.2,
};

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function adapterWith(fetchMock: ReturnType<typeof vi.fn>, value = secret()) {
  return new AntigravityAdapter(value, undefined, fetchMock as unknown as (input: string, init?: RequestInit) => Promise<Response>);
}

describe('AntigravityAdapter request protocol', () => {
  it('posts the Code Assist envelope with the project, roles, system instruction and thinking config', async () => {
    const fetchMock = vi.fn(async () => sse([
      candidate([{ text: 'thinking…', thought: true }, { text: 'Looks ' }]),
      candidate([{ text: 'good.' }], 'STOP', { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 50 }),
    ]));
    const chunks = await collect(adapterWith(fetchMock).stream(options));

    expect(chunks).toEqual([
      { type: 'text-delta', text: 'Looks ' },
      { type: 'text-delta', text: 'good.' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0 } },
      { type: 'finish', reason: 'stop' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DAILY);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${access}`);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('user-agent')).toMatch(/^antigravity\//);
    expect(JSON.parse(headers.get('client-metadata') ?? '{}')).toMatchObject({ ideType: 'ANTIGRAVITY' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      project: 'project-1',
      model: 'gemini-3.1-pro',
      userAgent: 'antigravity',
      request: {
        systemInstruction: { parts: [{ text: 'You review code.' }] },
        contents: [
          { role: 'user', parts: [{ text: 'Review this diff.' }] },
          { role: 'model', parts: [{ text: 'Earlier answer.' }] },
        ],
        generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false } },
      },
    });
    expect(body.requestId).toMatch(/^agent-/);
    expect(body.request.generationConfig.maxOutputTokens).toBe(1000 + 16384);
    expect(body.request).not.toHaveProperty('tools');
  });

  it('gives Claude models a thinking budget below the output limit, and none with effort off', async () => {
    const fetchMock = vi.fn(async () => sse([candidate([{ text: 'ok' }], 'STOP')]));
    const adapter = adapterWith(fetchMock);
    await collect(adapter.stream({ ...options, model: 'claude-sonnet-4-6', effort: 'medium' }));
    const thinking = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).request.generationConfig;
    expect(thinking).toMatchObject({ maxOutputTokens: 1000 + 8192, thinkingConfig: { thinkingBudget: 8192 } });
    expect(adapter.requestedOutputTokens({ model: 'claude-sonnet-4-6', effort: 'medium', maxOutputTokens: 1000 })).toBe(9192);

    await collect(adapter.stream({ ...options, model: 'claude-sonnet-4-6', effort: 'off' }));
    const off = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).request.generationConfig;
    expect(off).not.toHaveProperty('thinkingConfig');
    expect(off.maxOutputTokens).toBe(1000);
  });

  it('maps MAX_TOKENS and safety finishes', async () => {
    const maxTokens = await collect(adapterWith(vi.fn(async () => sse([candidate([{ text: 'cut' }], 'MAX_TOKENS')]))).stream(options));
    expect(maxTokens.at(-1)).toEqual({ type: 'finish', reason: 'max-tokens' });
    const blocked = await collect(adapterWith(vi.fn(async () => sse([candidate([], 'SAFETY')]))).stream(options));
    expect(blocked.at(-1)).toEqual({ type: 'finish', reason: 'error' });
  });
});

describe('AntigravityAdapter hosts', () => {
  it.each([
    ['503', async () => new Response('busy', { status: 503 })],
    ['404', async () => new Response('', { status: 404 })],
    ['no connection', async () => { throw new TypeError('fetch failed'); }],
  ])('moves to the next host on %s before any byte was streamed', async (_name, first) => {
    const fetchMock = vi.fn().mockImplementationOnce(first).mockImplementationOnce(async () => sse([candidate([{ text: 'ok' }], 'STOP')]));
    const chunks = await collect(adapterWith(fetchMock).stream(options));
    expect(chunks[0]).toEqual({ type: 'text-delta', text: 'ok' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([DAILY, PROD]);
  });

  it.each([401, 403, 429])('does not try another host on %s', async (status) => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: status, status: 'X', message: 'no' } }, { status }));
    await expect(collect(adapterWith(fetchMock).stream(options))).rejects.toMatchObject({ provider: 'google-antigravity' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the last host failure when every host fails', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(collect(adapterWith(fetchMock).stream(options))).rejects.toMatchObject({ code: 'NETWORK' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AntigravityAdapter failures', () => {
  it('raises an error event inside the stream as a classified failure', async () => {
    const fetchMock = vi.fn(async () => sse([candidate([{ text: 'part' }]), { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your quota will reset after 5h.' } }]));
    const stream = adapterWith(fetchMock).stream(options)[Symbol.asyncIterator]();
    expect(await stream.next()).toMatchObject({ value: { type: 'text-delta', text: 'part' } });
    await expect(stream.next()).rejects.toMatchObject({ code: 'QUOTA' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no candidate at all', [{ traceId: 'only' }]],
    ['text but no finishReason', [candidate([{ text: 'half an ans' }])]],
  ])('treats a stream that ends with %s as cut off, not as a finished answer', async (_name, events) => {
    await expect(collect(adapterWith(vi.fn(async () => sse(events))).stream(options))).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('fails on a malformed stream event instead of skipping it', async () => {
    const body = new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"a"}]}}]}}\n\ndata: {broken\n\n', { status: 200 });
    await expect(collect(adapterWith(vi.fn(async () => body)).stream(options))).rejects.toMatchObject({ code: 'UNKNOWN', message: expect.stringMatching(/malformed/) });
  });

  it('cancels the response body when the caller stops early or an error event ends the stream', async () => {
    const cancelled = vi.fn();
    const open = (events: unknown[]) => {
      const text = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      // Never closed: only a cancel ends it, as with a live connection.
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(text); }, cancel: cancelled }), { status: 200 });
    };
    for await (const chunk of adapterWith(vi.fn(async () => open([candidate([{ text: 'first' }])]))).stream(options)) {
      expect(chunk).toEqual({ type: 'text-delta', text: 'first' });
      break;
    }
    expect(cancelled).toHaveBeenCalledTimes(1);

    const quota = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your quota will reset after 5h.' } };
    await expect(collect(adapterWith(vi.fn(async () => open([quota]))).stream(options))).rejects.toMatchObject({ code: 'QUOTA' });
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it('asks for a new sign-in when the credential has no project or Google refused the refresh', async () => {
    const fetchMock = vi.fn();
    await expect(collect(adapterWith(fetchMock, secret('')).stream(options))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    const refused = new AntigravityAdapter(secret(), async () => { throw new SubscriptionRefreshError(false); }, fetchMock as never);
    await expect(collect(refused.stream(options))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an unreachable token endpoint', new SubscriptionRefreshError(true), 'NETWORK'],
    ['a lock or database error while loading the credential', new Error('connection terminated'), 'SERVER'],
  ])('reports %s as a transient failure, not as an invalid sign-in', async (_name, cause, code) => {
    const adapter = new AntigravityAdapter(secret(), async () => { throw cause; }, vi.fn() as never);
    const failure = await collect(adapter.stream(options)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code });
    expect(classifyFailure((failure as LlmFailure).code)).toBe('transient');
  });

  it('uses the credential resolved before each call', async () => {
    const fetchMock = vi.fn(async () => sse([candidate([{ text: 'ok' }], 'STOP')]));
    const refreshed = new Secret(encodeSubscription('google-antigravity', {
      type: 'oauth', access: REFRESHED_ACCESS, refresh: 'fake-refresh-token', expires: Date.now() + 3_600_000, projectId: 'project-1',
    }));
    await collect(new AntigravityAdapter(secret(), async () => refreshed, fetchMock as never).stream(options));
    expect(new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization')).toBe(`Bearer ${REFRESHED_ACCESS}`);
  });
});

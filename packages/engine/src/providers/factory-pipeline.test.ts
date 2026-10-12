import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergePilotConfigSchema, type MergePilotConfig } from '../config/schema.js';
import { EnvCredentialStore } from '../credentials/store.js';
import type { GenerateOptions, StreamChunk } from '../llm/types.js';
import { FallbackChain } from '../review/fallback.js';
import { modelFromAdapter, type ReviewModel } from '../review/model.js';
import { runReview } from '../review/pipeline.js';
import { OpenAICompatibleAdapter } from './compatible/adapter.js';
import { createReviewModel, CUSTOM_BASE_URL_MISSING, resolveReviewSecrets } from './factory.js';
import { OpenAIAdapter } from './openai/adapter.js';

const CWD = '/test/workspace';
const ANSWER = '{"summary":"ok","findings":[]}';
/** An exact fallback key in a format no pattern recognises, built at runtime. */
const FALLBACK_KEY = ['zq', 'x9'.repeat(8), 'mn'].join('');

function config(input: Record<string, unknown>): MergePilotConfig {
  return MergePilotConfigSchema.parse({ language: 'en', ...input });
}

async function* answer(): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', text: ANSWER };
  yield { type: 'finish', reason: 'stop' };
}

function patchWith(line: string): string {
  return `@@ -1,1 +1,2 @@\n const a = 1;\n+${line}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fallback keys take part in redaction', () => {
  it('redacts an exact fallback key from the prompt sent to the PRIMARY model', async () => {
    const sent: GenerateOptions[] = [];
    vi.spyOn(OpenAIAdapter.prototype, 'stream').mockImplementation((options: GenerateOptions) => {
      sent.push(options);
      return answer();
    });
    const store = new EnvCredentialStore({ OPENAI_API_KEY: 'k1', XAI_API_KEY: FALLBACK_KEY });
    const cfg = config({
      provider: 'openai',
      model: 'gpt-5',
      fallback: [{ provider: 'xai', model: 'grok-4' }],
      review: { verify: false },
    });
    const model = await createReviewModel(cfg, store, { cwd: CWD });

    const result = await runReview({
      config: cfg,
      pr: { title: 't', body: `see ${FALLBACK_KEY}` },
      files: [{ path: 'src/a.ts', status: 'modified', patch: patchWith(`// ${FALLBACK_KEY}`), changes: 1 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    expect(sent).toHaveLength(1);
    const prompt = sent[0]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(prompt).not.toContain(FALLBACK_KEY);
    expect(prompt).toContain('[REDACTED:known]');
  });

  it('skips a fallback whose key is missing and discloses why, without stopping the review', async () => {
    vi.spyOn(OpenAIAdapter.prototype, 'stream').mockImplementation(() => answer());
    const store = new EnvCredentialStore({ OPENAI_API_KEY: 'k1' });
    const cfg = config({
      provider: 'openai',
      model: 'gpt-5',
      fallback: [{ provider: 'xai', model: 'grok-4' }],
      review: { verify: false },
    });
    const model = await createReviewModel(cfg, store, { cwd: CWD });

    expect(model.fallbacks).toBeUndefined();
    expect(model.skippedFallbacks).toEqual([{ label: 'xai:grok-4', reason: expect.stringContaining('XAI_API_KEY') }]);
    const result = await runReview({
      config: cfg,
      pr: { title: 't', body: '' },
      files: [{ path: 'src/a.ts', status: 'modified', patch: patchWith('const b = 2;'), changes: 1 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.skippedFallbacks).toEqual([{ label: 'xai:grok-4', reason: expect.stringContaining('XAI_API_KEY') }]);
    }
  });

  it('resolveReviewSecrets returns the primary and present fallback keys, and allows a keyless custom primary', async () => {
    const store = new EnvCredentialStore({ XAI_API_KEY: FALLBACK_KEY });
    const cfg = config({
      provider: 'custom',
      model: 'local',
      baseUrl: 'http://localhost:8080/v1',
      fallback: [{ provider: 'xai', model: 'grok-4' }, { provider: 'deepseek', model: 'deepseek-chat' }],
    });
    const secrets = await resolveReviewSecrets(cfg, store);
    expect(secrets.map((s) => s.reveal())).toEqual([FALLBACK_KEY]);
  });
});

describe('each fallback honours its own effort', () => {
  it('sends the fallback entry effort, not the primary one', async () => {
    const efforts: Array<string | undefined> = [];
    vi.spyOn(OpenAICompatibleAdapter.prototype, 'stream').mockImplementation((options: GenerateOptions) => {
      efforts.push(options.effort);
      return answer();
    });
    const store = new EnvCredentialStore({ OPENAI_API_KEY: 'k1', XAI_API_KEY: 'k2', DEEPSEEK_API_KEY: 'k3' });
    const cfg = config({
      provider: 'openai',
      model: 'gpt-5',
      effort: 'low',
      fallback: [
        { provider: 'xai', model: 'grok-4', effort: 'high' },
        { provider: 'deepseek', model: 'deepseek-chat' },
      ],
    });
    const model = await createReviewModel(cfg, store, { cwd: CWD });
    const [first, second] = model.fallbacks ?? [];

    await first?.generate({ system: 's', user: 'u', maxOutputTokens: 100 });
    await second?.generate({ system: 's', user: 'u', maxOutputTokens: 100 });

    expect(efforts).toEqual(['high', undefined]);
    expect(model.outputTokensFor?.(4096)).toBe(4096 + 2048);
    expect(first?.outputTokensFor?.(4096)).toBe(4096 + 16384);
    expect(second?.outputTokensFor?.(4096)).toBe(4096);
  });
});

describe('budget preflight prices the effort headroom', () => {
  // $10 per million output tokens, input free: no effort = (4096 + 2048) * 10 / 1e6 ≈ $0.061;
  // effort high adds 16384 thinking tokens to EACH call ≈ $0.389, above the $0.10 limit.
  const pricing = { inputPerMTok: 0, outputPerMTok: 10 };
  const files = [{ path: 'src/a.ts', status: 'modified', patch: patchWith('const b = 2;'), changes: 1 }];

  function xaiModel(effort?: string): ReviewModel {
    return modelFromAdapter(new OpenAICompatibleAdapter({ provider: 'xai', apiKey: 'k1' }), 'grok-4', effort);
  }

  it('the request max_tokens and the priced output tokens agree', () => {
    const adapter = new OpenAICompatibleAdapter({ provider: 'xai', apiKey: 'k1' });
    const options = { model: 'grok-4', messages: [], maxOutputTokens: 4096, effort: 'high' };
    expect(adapter.requestBody(options).max_tokens).toBe(adapter.requestedOutputTokens(options));
  });

  it('skips a review whose configured high effort would exceed perReviewUsd', async () => {
    const stream = vi.spyOn(OpenAICompatibleAdapter.prototype, 'stream').mockImplementation(() => answer());
    const cfg = config({ provider: 'xai', model: 'grok-4', effort: 'high', budget: { perReviewUsd: 0.1, pricing } });

    const result = await runReview({ config: cfg, pr: { title: 't', body: '' }, files, rulesFiles: [], model: xaiModel('high'), knownSecrets: [] });

    expect(result.status).toBe('skipped-budget');
    expect(stream).not.toHaveBeenCalled();
  });

  it('runs the same review without effort under the same limit', async () => {
    vi.spyOn(OpenAICompatibleAdapter.prototype, 'stream').mockImplementation(() => answer());
    const cfg = config({ provider: 'xai', model: 'grok-4', budget: { perReviewUsd: 0.1, pricing } });

    const result = await runReview({ config: cfg, pr: { title: 't', body: '' }, files, rulesFiles: [], model: xaiModel(), knownSecrets: [] });

    expect(result.status).toBe('completed');
  });

  it('uses the largest output limit across the fallback chain', () => {
    const chain = new FallbackChain(xaiModel(), [xaiModel('high'), xaiModel('low')]);
    expect(chain.outputTokensFor(2048)).toBe(2048 + 16384);
  });
});

describe('a key is never sent to a URL from repository content (ADR-0008 amendment)', () => {
  const okStream = () =>
    new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}

data: [DONE]

`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

  it('custom: ignores the config file baseUrl and calls only the trusted customBaseUrl', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (urls.push(url), okStream())));
    try {
      const store = new EnvCredentialStore({ CUSTOM_LLM_API_KEY: FALLBACK_KEY });
      const cfg = config({ provider: 'custom', model: 'local', baseUrl: 'https://evil.example/v1' });
      const model = await createReviewModel(cfg, store, { cwd: CWD, customBaseUrl: 'http://localhost:8080/v1' });
      await model.generate({ system: 's', user: 'u', maxOutputTokens: 10 });
      expect(urls).toEqual(['http://localhost:8080/v1/chat/completions']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('custom without a trusted URL fails clearly instead of using the file baseUrl', async () => {
    const cfg = config({ provider: 'custom', model: 'local', baseUrl: 'https://evil.example/v1' });
    await expect(createReviewModel(cfg, new EnvCredentialStore({}), { cwd: CWD })).rejects.toThrow(CUSTOM_BASE_URL_MISSING);
  });

  it('a custom fallback without a trusted URL is skipped and disclosed', async () => {
    const store = new EnvCredentialStore({ OPENAI_API_KEY: 'k1' });
    const cfg = config({ provider: 'openai', model: 'gpt-5', fallback: [{ provider: 'custom', model: 'local' }] });
    const model = await createReviewModel(cfg, store, { cwd: CWD });
    expect(model.skippedFallbacks).toEqual([{ label: 'custom:local', reason: expect.stringContaining('CUSTOM_LLM_BASE_URL') }]);
  });

  it('custom: a shell-provided customFetch carries the primary and a custom fallback call, never a preset', async () => {
    const guarded: string[] = [];
    const global: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (global.push(url), okStream())));
    try {
      const store = new EnvCredentialStore({ CUSTOM_LLM_API_KEY: FALLBACK_KEY, OPENAI_API_KEY: 'k1' });
      const customFetch = async (url: string) => (guarded.push(url), okStream());
      const primary = await createReviewModel(config({ provider: 'custom', model: 'local' }), store, {
        cwd: CWD,
        customBaseUrl: 'https://llm.example/v1',
        customFetch,
      });
      await primary.generate({ system: 's', user: 'u', maxOutputTokens: 10 });
      const withFallback = await createReviewModel(
        config({ provider: 'openai', model: 'gpt-5', fallback: [{ provider: 'custom', model: 'local' }] }),
        store,
        { cwd: CWD, customBaseUrl: 'https://llm.example/v1', customFetch },
      );
      await withFallback.fallbacks?.[0]?.generate({ system: 's', user: 'u', maxOutputTokens: 10 });
      expect(guarded).toEqual(['https://llm.example/v1/chat/completions', 'https://llm.example/v1/chat/completions']);
      expect(global).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a preset adapter always calls its fixed registry URL, whatever baseUrl is passed', async () => {
    const urls: string[] = [];
    const adapter = new OpenAICompatibleAdapter({
      provider: 'openrouter',
      apiKey: 'k1',
      baseUrl: 'https://evil.example/v1',
      fetch: async (url) => (urls.push(String(url)), okStream()),
    });
    await modelFromAdapter(adapter, 'openai/gpt-5').generate({ system: 's', user: 'u', maxOutputTokens: 10 });
    expect(urls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });
});

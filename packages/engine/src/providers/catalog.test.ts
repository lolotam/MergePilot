import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { LlmFailure } from '../llm/failure.js';
import { listModels } from './catalog.js';
import { jsonResponse, mockFetch, textResponse } from './fetch-mock.fixtures.js';

const KEY = new Secret('sk-test-catalog-key-12345');

describe('listModels', () => {
  describe('Anthropic', () => {
    it('requests models with x-api-key and anthropic-version, following pages', async () => {
      const page1 = {
        data: [
          {
            id: 'claude-sonnet-5-5',
            display_name: 'Claude 5.5 Sonnet',
            max_input_tokens: 200000,
            capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } } },
          },
        ],
        has_more: true,
        last_id: 'page1-last',
      };
      const page2 = {
        data: [
          {
            id: 'claude-opus-4',
            display_name: 'Claude 4 Opus',
            max_input_tokens: 180000,
            capabilities: { thinking: { supported: false } },
          },
          {
            id: 'claude-haiku-4-5',
            display_name: 'Claude 4.5 Haiku',
          },
        ],
        has_more: false,
      };

      const { fetch, calls } = mockFetch(jsonResponse(page1), jsonResponse(page2));
      const models = await listModels('anthropic', KEY, { fetch });

      expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
      expect(calls[0]?.headers['x-api-key']).toBe(KEY.reveal());
      expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
      expect(calls[1]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=page1-last');

      expect(models).toEqual([
        { id: 'claude-haiku-4-5', name: 'Claude 4.5 Haiku', efforts: ['off', 'low', 'medium', 'high'] },
        { id: 'claude-opus-4', name: 'Claude 4 Opus', efforts: [], contextWindow: 180000 },
        { id: 'claude-sonnet-5-5', name: 'Claude 5.5 Sonnet', efforts: ['off', 'low', 'high'], contextWindow: 200000 },
      ]);
    });
  });

  describe('OpenAI', () => {
    it('requests /v1/models with Bearer token, filters chat models and sets reasoning efforts', async () => {
      const body = {
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-5' },
          { id: 'o1-preview' },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
          { id: 'dall-e-3' },
          { id: 'sora-2' },
          { id: 'chatgpt-4o-latest' },
        ],
      };
      const { fetch, calls } = mockFetch(jsonResponse(body));
      const models = await listModels('openai', KEY, { fetch });

      expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);

      expect(models).toEqual([
        { id: 'chatgpt-4o-latest', name: 'chatgpt-4o-latest', efforts: [] },
        { id: 'gpt-4o', name: 'gpt-4o', efforts: [] },
        { id: 'gpt-5', name: 'gpt-5', efforts: ['off', 'low', 'medium', 'high'] },
        { id: 'o1-preview', name: 'o1-preview', efforts: ['off', 'low', 'medium', 'high'] },
      ]);
    });
  });

  describe('Gemini', () => {
    it('sends x-goog-api-key header and never puts the key in the URL', async () => {
      const page1 = {
        models: [
          {
            name: 'models/gemini-3.8-flash',
            displayName: 'Gemini 3.8 Flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
            inputTokenLimit: 1048576,
          },
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            supportedGenerationMethods: ['generateContent'],
            thinking: true,
            inputTokenLimit: 524288,
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
        nextPageToken: 'next-gemini-page',
      };
      const page2 = {
        models: [
          {
            name: 'models/gemini-1.5-flash',
            displayName: 'Gemini 1.5 Flash',
            supportedGenerationMethods: ['generateContent'],
            thinking: false,
          },
        ],
      };

      const { fetch, calls } = mockFetch(jsonResponse(page1), jsonResponse(page2));
      const models = await listModels('gemini', KEY, { fetch });

      expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
      expect(calls[0]?.url).not.toContain(KEY.reveal());
      expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY.reveal());
      expect(calls[1]?.url).toContain('pageToken=next-gemini-page');
      expect(calls[1]?.url).not.toContain(KEY.reveal());

      expect(models).toEqual([
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', efforts: [] },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', efforts: ['minimal', 'low', 'medium', 'high'], contextWindow: 524288 },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['minimal', 'low', 'medium', 'high'], contextWindow: 1048576 },
      ]);
    });
  });

  describe('Compatible presets', () => {
    it('supports OpenRouter including free models and supported_parameters efforts', async () => {
      const body = {
        data: [
          {
            id: 'openai/gpt-5',
            name: 'OpenAI: GPT-5',
            context_length: 128000,
            supported_parameters: ['tools', 'reasoning'],
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct:free',
            name: 'Meta: Llama 3.3 70B Instruct (free)',
            context_length: 65536,
            supported_parameters: ['tools'],
          },
          {
            id: 'qwen/qwen-2.5-coder-32b-instruct:free',
            name: 'Qwen 2.5 Coder 32B (free)',
            context_window: 32768,
          },
          {
            id: 'openai/text-embedding-ada-002',
            type: 'embedding',
          },
        ],
      };
      const { fetch, calls } = mockFetch(jsonResponse(body));
      const models = await listModels('openrouter', KEY, { fetch });

      expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);
      expect(models).toEqual([
        {
          id: 'meta-llama/llama-3.3-70b-instruct:free',
          name: 'Meta: Llama 3.3 70B Instruct (free)',
          efforts: [],
          contextWindow: 65536,
        },
        {
          id: 'openai/gpt-5',
          name: 'OpenAI: GPT-5',
          efforts: ['off', 'low', 'medium', 'high'],
          contextWindow: 128000,
        },
        {
          id: 'qwen/qwen-2.5-coder-32b-instruct:free',
          name: 'Qwen 2.5 Coder 32B (free)',
          efforts: ['off', 'low', 'medium', 'high'],
          contextWindow: 32768,
        },
      ]);
    });

    it('supports Z.ai coding plan with glm thinking efforts', async () => {
      const body = {
        data: [{ id: 'glm-4.6', name: 'glm-4.6' }],
      };
      const { fetch, calls } = mockFetch(jsonResponse(body));
      const models = await listModels('zai-coding', KEY, { fetch });

      expect(calls[0]?.url).toBe('https://api.z.ai/api/coding/paas/v4/models');
      expect(models).toEqual([
        { id: 'glm-4.6', name: 'glm-4.6', efforts: ['on', 'off'] },
      ]);
    });

    it('falls back to unauthenticated public list when key returns 401 or 403', async () => {
      const body = { data: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] };
      const { fetch, calls } = mockFetch(
        textResponse('unauthorized key', 401),
        jsonResponse(body, 200),
      );
      const models = await listModels('deepseek', KEY, { fetch });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);
      expect(calls[1]?.headers.authorization).toBeUndefined();
      expect(models).toEqual([{ id: 'deepseek-chat', name: 'DeepSeek Chat', efforts: [] }]);
    });
  });

  describe('Deduplication and sorting', () => {
    it('de-duplicates models and sorts alphabetically by id', async () => {
      const body = {
        data: [
          { id: 'zebra-model' },
          { id: 'alpha-model' },
          { id: 'alpha-model', name: 'Alpha duplicate' },
        ],
      };
      const { fetch } = mockFetch(jsonResponse(body));
      const models = await listModels('xai', KEY, { fetch });
      expect(models.map((m) => m.id)).toEqual(['alpha-model', 'zebra-model']);
      expect(models[0]?.name).toBe('alpha-model');
    });
  });

  describe('Error handling and secret redaction', () => {
    it('throws LlmFailure with redacted key on 401 failure', async () => {
      const { fetch } = mockFetch(textResponse(`Invalid key: ${KEY.reveal()}`, 401), textResponse('forbidden', 403));
      await expect(listModels('anthropic', KEY, { fetch })).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(LlmFailure);
        const f = err as LlmFailure;
        expect(f.code).toBe('INVALID_CREDENTIAL');
        expect(f.message).not.toContain(KEY.reveal());
        expect(f.message).toContain('[REDACTED');
        return true;
      });
    });

    it('throws LlmFailure with RATE_LIMIT on 429', async () => {
      const { fetch } = mockFetch(jsonResponse({ error: { message: 'Too many requests' } }, 429));
      await expect(listModels('openai', KEY, { fetch })).rejects.toMatchObject({
        code: 'RATE_LIMIT',
      });
    });

    it('throws LlmFailure with NETWORK when fetch throws', async () => {
      const { fetch } = mockFetch(() => {
        throw new TypeError(`Failed to fetch from host with key ${KEY.reveal()}`);
      });
      await expect(listModels('gemini', KEY, { fetch })).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(LlmFailure);
        const f = err as LlmFailure;
        expect(f.code).toBe('NETWORK');
        expect(f.message).not.toContain(KEY.reveal());
        return true;
      });
    });
  });
});

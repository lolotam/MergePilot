import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { testConnection } from './connection.js';
import { hangingFetch, jsonResponse, mockFetch, textResponse } from './fetch-mock.fixtures.js';

const KEY = new Secret('sk-test-conn-key-99999');

describe('testConnection', () => {
  describe('Anthropic', () => {
    it('sends prompt to /messages and extracts reply', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          content: [{ type: 'text', text: 'OK' }],
        }),
      );

      const result = await testConnection('anthropic', KEY, 'claude-sonnet-5-5', { fetch, effort: 'high' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reply).toBe('OK');
        expect(result.model).toBe('claude-sonnet-5-5');
        expect(result.ms).toBeGreaterThanOrEqual(0);
      }
      expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
      expect(calls[0]?.headers['x-api-key']).toBe(KEY.reveal());
      expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
      expect(calls[0]?.body).toMatchObject({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Reply with the single word OK' }],
        max_tokens: 16 + 16384,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      });
    });
  });

  describe('OpenAI', () => {
    it('sends chat completion with reasoning_effort and extracts reply', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('openai', KEY, 'gpt-5', { fetch, effort: 'medium' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reply).toBe('OK');
        expect(result.model).toBe('gpt-5');
      }
      expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);
      expect(calls[0]?.body).toMatchObject({
        model: 'gpt-5',
        reasoning_effort: 'medium',
        max_completion_tokens: 16 + 8192,
      });
    });
  });

  describe('Gemini', () => {
    it('sends generateContent with x-goog-api-key header and extracts reply', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      );

      const result = await testConnection('gemini', KEY, 'gemini-3.8-flash', { fetch, effort: 'low' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reply).toBe('OK');
        expect(result.model).toBe('gemini-3.8-flash');
      }
      expect(calls[0]?.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      );
      expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY.reveal());
      expect(calls[0]?.body).toMatchObject({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: 'LOW' },
          maxOutputTokens: 16 + 2048,
        },
      });
    });
  });

  describe('Compatible presets', () => {
    it('sends session header to OpenCode', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('opencode-zen', KEY, 'glm-5.3', { fetch });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe('https://opencode.ai/zen/v1/chat/completions');
      expect(calls[0]?.headers['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('maps thinking effort for Z.ai coding preset', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('zai-coding', KEY, 'glm-4.6', { fetch, effort: 'on' });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
      expect(calls[0]?.body).toMatchObject({
        model: 'glm-4.6',
        thinking: { type: 'enabled' },
      });
    });
  });

  describe('Failure cases and redaction', () => {
    it('returns code auth on 401 error and redacts key from message', async () => {
      const { fetch } = mockFetch(textResponse(`Invalid key: ${KEY.reveal()}`, 401));

      const result = await testConnection('anthropic', KEY, 'claude-sonnet-5-5', { fetch });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('auth');
        expect(result.message).not.toContain(KEY.reveal());
        expect(result.message).toContain('[REDACTED');
        expect(result.ms).toBeGreaterThanOrEqual(0);
      }
    });

    it('returns code rate-limit on 429 error', async () => {
      const { fetch } = mockFetch(jsonResponse({ error: { message: 'Too many requests' } }, 429));

      const result = await testConnection('xai', KEY, 'grok-4', { fetch });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('rate-limit');
      }
    });

    it('returns code quota on 402 error', async () => {
      const { fetch } = mockFetch(jsonResponse({ error: { message: 'Insufficient balance' } }, 402));

      const result = await testConnection('openrouter', KEY, 'openai/gpt-5', { fetch });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('quota');
      }
    });

    it('returns code server on 500 error', async () => {
      const { fetch } = mockFetch(textResponse('Internal error', 500));

      const result = await testConnection('deepseek', KEY, 'deepseek-chat', { fetch });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('server');
      }
    });

    it('returns code network on connection timeout', async () => {
      const result = await testConnection('openai', KEY, 'gpt-5', {
        fetch: hangingFetch(),
        timeoutMs: 50,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('network');
        expect(result.message).toContain('did not answer within 50 ms');
      }
    });

    it('returns code network on fetch throw and redacts key', async () => {
      const { fetch } = mockFetch(() => {
        throw new TypeError(`DNS resolution failed for ${KEY.reveal()}`);
      });

      const result = await testConnection('nvidia', KEY, 'nvidia/nemotron-3-super-120b-a12b', { fetch });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('network');
        expect(result.message).not.toContain(KEY.reveal());
      }
    });
  });
});

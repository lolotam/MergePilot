import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { testConnection } from './connection.js';
import { hangingFetch, jsonResponse, mockFetch, textResponse } from './fetch-mock.fixtures.js';

// Built at runtime so no literal in the repository looks like a real key.
const KEY = new Secret(['s', 'k-', 'c'.repeat(24)].join(''));

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

    it('tests Xiaomi MiMo connection with default model mimo-v2.5 with reasoning headroom', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('xiaomi', KEY, 'mimo-v2.5', { fetch });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);
      expect((calls[0]?.body as { max_tokens: number }).max_tokens).toBe(16 + 8192);
    });

    it('tests Xiaomi MiMo mimo-v2-pro and reserves headroom for reasoning', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('xiaomi', KEY, 'mimo-v2-pro', { fetch });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
      expect((calls[0]?.body as { max_tokens: number }).max_tokens).toBe(16 + 8192);
    });

    it('tests Xiaomi MiMo Token Plan default Singapore region', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('xiaomi-token-plan', KEY, 'mimo-v2.5', { fetch });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
    });

    it('tests MiniMax with the thinking split out and room left for it', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('minimax', KEY, 'MiniMax-M3.1-Flash', { fetch });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe('https://api.minimax.io/v1/chat/completions');
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);
      expect(calls[0]?.body).toMatchObject({ model: 'MiniMax-M3.1-Flash', reasoning_split: true });
      expect(calls[0]?.body).not.toHaveProperty('thinking');
      // MiniMax thinks at its default depth `max`, so the whole `max` budget is reserved.
      expect((calls[0]?.body as { max_tokens: number }).max_tokens).toBe(16 + 32000);
    });

    it('tests a MiniMax model that ignores the depth with the default room for its thinking', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('minimax', KEY, 'MiniMax-M3', { fetch, effort: 'high' });

      expect(result.ok).toBe(true);
      expect(calls[0]?.body).toMatchObject({ model: 'MiniMax-M3', reasoning_split: true });
      expect(calls[0]?.body).not.toHaveProperty('reasoning_effort');
      expect((calls[0]?.body as { max_tokens: number }).max_tokens).toBe(16 + 32000);
    });

    it('tests the MiniMax Coding Plan on the same endpoint, with its own key', async () => {
      const { fetch, calls } = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'OK' } }],
        }),
      );

      const result = await testConnection('minimax-coding-plan', KEY, 'MiniMax-M3.1-Flash', { fetch, effort: 'high' });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe('https://api.minimax.io/v1/chat/completions');
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);
      expect(calls[0]?.body).toMatchObject({
        model: 'MiniMax-M3.1-Flash',
        reasoning_split: true,
        reasoning_effort: 'high',
        max_tokens: 16 + 16384,
      });
      expect(calls[0]?.body).not.toHaveProperty('thinking');
    });
  });

  describe('Empty replies', () => {
    it('returns invalid-response when Gemini blocks the candidate and sends no text', async () => {
      const { fetch } = mockFetch(
        jsonResponse({ candidates: [{ finishReason: 'SAFETY', safetyRatings: [] }], promptFeedback: {} }),
      );

      const result = await testConnection('gemini', KEY, 'gemini-3.8-flash', { fetch });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid-response');
    });

    it('returns invalid-response when a compatible endpoint answers with an unexpected payload', async () => {
      const { fetch } = mockFetch(jsonResponse({ result: { output: 'OK' } }));

      const result = await testConnection('custom', undefined, 'local-model', {
        fetch,
        baseUrl: 'http://localhost:8080/v1',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid-response');
        expect(result.message).toContain('custom');
      }
    });

    it('returns invalid-response when the body is not JSON', async () => {
      const { fetch } = mockFetch(textResponse('<html>gateway</html>', 200));

      const result = await testConnection('xai', KEY, 'grok-4', { fetch });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid-response');
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

    it('returns code quota when Anthropic answers 400 "credit balance is too low"', async () => {
      const { fetch } = mockFetch(
        jsonResponse(
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' },
          },
          400,
        ),
      );
      const result = await testConnection('anthropic', KEY, 'claude-sonnet-5-5', { fetch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('quota');
    });

    it('returns code quota on OpenAI insufficient_quota 429', async () => {
      const { fetch } = mockFetch(
        jsonResponse({ error: { message: 'You exceeded your current quota.', code: 'insufficient_quota' } }, 429),
      );
      const result = await testConnection('openai', KEY, 'gpt-5', { fetch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('quota');
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

  describe('thinking models (live bug: Test button failed with "answered without any reply text")', () => {
    it('gives NVIDIA Nemotron (default model) thinking room with no effort', async () => {
      const { fetch, calls } = mockFetch(jsonResponse({ choices: [{ message: { content: 'OK' } }] }));
      const result = await testConnection('nvidia', KEY, 'nvidia/nemotron-3-super-120b-a12b', { fetch });
      expect(result.ok).toBe(true);
      expect((calls[0]?.body as { max_tokens: number }).max_tokens).toBe(16 + 8192);
    });

    it('gives gpt-5 the default headroom with no effort configured (openAIThinksByDefault)', async () => {
      const { fetch, calls } = mockFetch(jsonResponse({ choices: [{ message: { content: 'OK' } }] }));
      const result = await testConnection('openai', KEY, 'gpt-5', { fetch });
      expect(result.ok).toBe(true);
      const body = calls[0]?.body as { max_completion_tokens: number; reasoning_effort?: string };
      expect(body.max_completion_tokens).toBe(16 + 8192);
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('strips a leading <think> block from content (NIM models)', async () => {
      const { fetch } = mockFetch(
        jsonResponse({ choices: [{ message: { content: '<think>The user wants OK.</think>\n\nOK' } }] }),
      );
      const result = await testConnection('nvidia', KEY, 'nvidia/nemotron-3-super-120b-a12b', { fetch });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.reply).toBe('OK');
    });

    it('counts a think-only content (closed or cut off) as a working connection', async () => {
      for (const content of ['<think>The user wants OK.</think>', '<think>The user wants OK, so I']) {
        const { fetch } = mockFetch(jsonResponse({ choices: [{ message: { content } }] }));
        const result = await testConnection('nvidia', KEY, 'nvidia/nemotron-3-super-120b-a12b', { fetch });
        expect(result.ok).toBe(true);
      }
    });

    it('still fails an empty think block with no reply', async () => {
      const { fetch } = mockFetch(jsonResponse({ choices: [{ message: { content: '<think></think>' } }] }));
      const result = await testConnection('nvidia', KEY, 'nvidia/nemotron-3-super-120b-a12b', { fetch });
      expect(result.ok).toBe(false);
    });

    it('gives GLM (zai-coding) thinking room by default and with effort "on"', async () => {
      for (const effort of [undefined, 'on'] as const) {
        const { fetch, calls } = mockFetch(jsonResponse({ choices: [{ message: { content: 'OK' } }] }));
        const result = await testConnection('zai-coding', KEY, 'glm-5.3', { fetch, ...(effort ? { effort } : {}) });
        expect(result.ok).toBe(true);
        expect((calls[0]?.body as { max_tokens: number }).max_tokens).toBeGreaterThanOrEqual(16 + 8192);
      }
    });

    it('counts a reasoning-only reply as a working connection', async () => {
      const { fetch } = mockFetch(
        jsonResponse({ choices: [{ message: { content: '', reasoning_content: 'The user wants OK' } }] }),
      );
      const result = await testConnection('zai-coding', KEY, 'glm-5.3', { fetch });
      expect(result.ok).toBe(true);
    });

    it('gives Gemini 3.x thinking room with no effort configured', async () => {
      const { fetch, calls } = mockFetch(jsonResponse({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
      const result = await testConnection('gemini', KEY, 'gemini-3.8-flash', { fetch });
      expect(result.ok).toBe(true);
      const config = (calls[0]?.body as { generationConfig: { maxOutputTokens: number } }).generationConfig;
      expect(config.maxOutputTokens).toBeGreaterThanOrEqual(16 + 8192);
    });

    it('keeps the tiny budget when thinking is explicitly off', async () => {
      const { fetch, calls } = mockFetch(jsonResponse({ choices: [{ message: { content: 'OK' } }] }));
      await testConnection('zai-coding', KEY, 'glm-5.3', { fetch, effort: 'off' });
      expect((calls[0]?.body as { max_tokens: number }).max_tokens).toBe(16);
    });
  });
});


import { describe, expect, it } from 'vitest';
import { Secret } from '../../credentials/secret.js';
import { listModels } from '../catalog.js';
import { jsonResponse, mockFetch } from '../fetch-mock.fixtures.js';

// Built at runtime so no literal in the repository looks like a real key.
const KEY = new Secret(['v', 'ck_', 'q'.repeat(24)].join(''));

/** The shape of `GET https://ai-gateway.vercel.sh/v1/models`. */
const gatewayList = {
  object: 'list',
  data: [
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      type: 'language',
      context_window: 200000,
      supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'],
    },
    {
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o mini',
      type: 'language',
      context_window: 128000,
      supported_parameters: ['max_tokens', 'temperature', 'tools'],
    },
    { id: 'openai/gpt-5-batch', name: 'GPT-5 (Batch)', type: 'language', supported_parameters: ['reasoning'] },
    { id: 'typesafe-ai/jev', name: 'Jev', type: 'language', context_window: 32000 },
    { id: 'openai/text-embedding-3-small', name: 'Embedding 3 Small', type: 'embedding' },
    { id: 'google/imagen-4.0-generate', name: 'Imagen 4', type: 'image' },
    { id: 'acme/grader-1', name: 'Grader', type: 'evaluation' },
    { id: 'acme/untyped-1', name: 'Untyped' },
  ],
};

describe('Vercel AI Gateway model list', () => {
  it('lists only language models with the key on the fixed URL, without batch variants or Jev', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(gatewayList));
    const models = await listModels('vercel-gateway', KEY, { fetch, baseUrl: 'https://proxy.example/v1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ai-gateway.vercel.sh/v1/models');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY.reveal()}`);
    expect(models).toEqual([
      {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        efforts: ['off', 'low', 'medium', 'high'],
        contextWindow: 200000,
      },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', efforts: [], contextWindow: 128000 },
    ]);
  });

  it('takes efforts from supported_parameters', async () => {
    const data = [
      { id: 'a/reasons', type: 'language', supported_parameters: ['reasoning'] },
      { id: 'b/effort', type: 'language', supported_parameters: ['reasoning_effort'] },
      { id: 'c/plain', type: 'language', supported_parameters: ['temperature'] },
    ];
    const { fetch } = mockFetch(jsonResponse({ data }));
    const models = await listModels('vercel-gateway', KEY, { fetch });
    expect(models.map((m) => [m.id, m.efforts])).toEqual([
      ['a/reasons', ['off', 'low', 'medium', 'high']],
      ['b/effort', ['off', 'low', 'medium', 'high']],
      ['c/plain', []],
    ]);
  });

  it('drops evaluation models from every compatible list', async () => {
    const data = [
      { id: 'openai/gpt-5', type: 'chat' },
      { id: 'acme/grader-1', type: 'evaluation' },
    ];
    const { fetch } = mockFetch(jsonResponse({ data }));
    expect((await listModels('openrouter', KEY, { fetch })).map((m) => m.id)).toEqual(['openai/gpt-5']);
  });
});

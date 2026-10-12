import { describe, expect, it } from 'vitest';
import {
  anthropicThinking,
  compatibleEffortFields,
  FALLBACK_EFFORTS,
  geminiThinkingConfig,
  openAIReasoningEffort,
  thinkingHeadroom,
} from './effort.js';

describe('FALLBACK_EFFORTS', () => {
  it('matches the Browser-controle table plus anthropic', () => {
    expect(FALLBACK_EFFORTS).toEqual({
      reasoning_effort: ['off', 'low', 'medium', 'high'],
      glm: ['on', 'off'],
      deepseek: ['off', 'low', 'high', 'max'],
      gemini: ['minimal', 'low', 'medium', 'high'],
      anthropic: ['off', 'low', 'medium', 'high'],
      none: [],
    });
  });
});

describe('compatibleEffortFields', () => {
  it('maps glm to thinking enabled/disabled', () => {
    expect(compatibleEffortFields('glm', 'on')).toEqual({ thinking: { type: 'enabled' } });
    expect(compatibleEffortFields('glm', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(compatibleEffortFields('glm', 'high')).toEqual({});
  });

  it('sends reasoning_effort unless off or empty', () => {
    expect(compatibleEffortFields('reasoning_effort', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(compatibleEffortFields('reasoning_effort', 'off')).toEqual({});
    expect(compatibleEffortFields('reasoning_effort', '')).toEqual({});
    expect(compatibleEffortFields('reasoning_effort', undefined)).toEqual({});
    expect(compatibleEffortFields('gemini', 'minimal')).toEqual({ reasoning_effort: 'minimal' });
  });

  it('never sends anything for thinkingStyle none, and ignores unknown efforts', () => {
    expect(compatibleEffortFields('none', 'high')).toEqual({});
    expect(compatibleEffortFields('reasoning_effort', 'turbo')).toEqual({});
  });
});

describe('openAIReasoningEffort', () => {
  it('sends only minimal|low|medium|high to reasoning models', () => {
    expect(openAIReasoningEffort('gpt-5', 'Medium')).toBe('medium');
    expect(openAIReasoningEffort('gpt-5-mini', 'minimal')).toBe('minimal');
    expect(openAIReasoningEffort('o3', 'high')).toBe('high');
    expect(openAIReasoningEffort('o4-mini', 'low')).toBe('low');
    for (const rejected of ['none', 'xhigh', 'max', 'off', 'on', 'banana', '', undefined]) {
      expect(openAIReasoningEffort('gpt-5', rejected)).toBeUndefined();
    }
  });

  it('sends nothing to non-reasoning models', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'chatgpt-4o-latest', 'gpt-5-chat-latest']) {
      expect(openAIReasoningEffort(model, 'high')).toBeUndefined();
    }
  });
});

describe('anthropicThinking', () => {
  it('uses a documented budget on models before adaptive thinking', () => {
    expect(anthropicThinking('claude-sonnet-4-5', 'low')).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(anthropicThinking('claude-sonnet-4-5', 'medium')).toEqual({ thinking: { type: 'enabled', budget_tokens: 8192 } });
    expect(anthropicThinking('claude-3-7-sonnet-latest', 'high')).toEqual({ thinking: { type: 'enabled', budget_tokens: 16384 } });
  });

  it('uses adaptive thinking with the effort parameter on newer models', () => {
    expect(anthropicThinking('claude-sonnet-5-5', 'high')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect(anthropicThinking('claude-opus-4-6', 'low')).toMatchObject({ thinking: { type: 'adaptive' } });
  });

  it('sends nothing for off, empty or unknown efforts', () => {
    expect(anthropicThinking('claude-sonnet-5-5', 'off')).toBeUndefined();
    expect(anthropicThinking('claude-sonnet-5-5', undefined)).toBeUndefined();
    expect(anthropicThinking('claude-sonnet-5-5', 'minimal')).toBeUndefined();
  });
});

describe('geminiThinkingConfig', () => {
  it('uses a token budget on Gemini 2.x, with off = 0 except on Pro', () => {
    expect(geminiThinkingConfig('gemini-2.5-flash', 'low')).toEqual({ thinkingBudget: 2048 });
    expect(geminiThinkingConfig('models/gemini-2.5-flash', 'off')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'off')).toBeUndefined();
  });

  it('uses a thinking level on Gemini 3 and later, where off is ignored', () => {
    expect(geminiThinkingConfig('gemini-3.8-flash', 'high')).toEqual({ thinkingLevel: 'HIGH' });
    expect(geminiThinkingConfig('gemini-3.8-flash', 'minimal')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(geminiThinkingConfig('gemini-3.8-flash', 'off')).toBeUndefined();
    expect(geminiThinkingConfig('gemini-3.8-flash', 'xhigh')).toBeUndefined();
  });
});

describe('thinkingHeadroom', () => {
  it('reserves extra output tokens only for thinking efforts', () => {
    expect(thinkingHeadroom('high')).toBe(16384);
    expect(thinkingHeadroom('off')).toBe(0);
    expect(thinkingHeadroom(undefined)).toBe(0);
  });
});

describe('default thinking headroom (P0.1)', () => {
  it('detects Gemini 2.5+ and 3.x models as thinking by default', async () => {
    const { geminiThinksByDefault } = await import('./effort.js');
    expect(geminiThinksByDefault('gemini-3.8-flash')).toBe(true);
    expect(geminiThinksByDefault('gemini-3-flash')).toBe(true);
    expect(geminiThinksByDefault('gemini-2.5-flash')).toBe(true);
    expect(geminiThinksByDefault('gemini-2.5-pro')).toBe(true);
    expect(geminiThinksByDefault('models/gemini-3.8-flash')).toBe(true);
    expect(geminiThinksByDefault('gemini-2.0-flash-thinking-exp')).toBe(true);
    // Non-thinking models
    expect(geminiThinksByDefault('gemini-2.0-flash')).toBe(false);
    expect(geminiThinksByDefault('gemini-1.5-pro')).toBe(false);
    expect(geminiThinksByDefault('gemini-1.5-flash')).toBe(false);
  });

  it('detects compatible reasoning models as thinking by default', async () => {
    const { isCompatibleReasoningModel } = await import('./effort.js');
    expect(isCompatibleReasoningModel('deepseek', 'deepseek-reasoner')).toBe(true);
    expect(isCompatibleReasoningModel('deepseek', 'deepseek-chat')).toBe(false);
    expect(isCompatibleReasoningModel('openrouter', 'deepseek/deepseek-r1')).toBe(true);
    expect(isCompatibleReasoningModel('openrouter', 'openai/o3-mini')).toBe(true);
    expect(isCompatibleReasoningModel('openrouter', 'google/gemini-3-flash')).toBe(true);
    expect(isCompatibleReasoningModel('openrouter', 'meta-llama/llama-3-70b')).toBe(false);
    expect(isCompatibleReasoningModel('zai', 'glm-4.6', 'glm')).toBe(true);
    expect(isCompatibleReasoningModel('zai-coding', 'glm-4.6', 'glm')).toBe(true);
    expect(isCompatibleReasoningModel('nvidia', 'nvidia/nemotron-3-super-120b-a12b')).toBe(true);
    expect(isCompatibleReasoningModel('nvidia', 'qwen/qwq-32b')).toBe(true);
    expect(isCompatibleReasoningModel('nvidia', 'deepseek-ai/deepseek-r1')).toBe(true);
    expect(isCompatibleReasoningModel('nvidia', 'some/model-reasoning')).toBe(true);
    expect(isCompatibleReasoningModel('nvidia', 'meta/llama-3.3-70b-instruct')).toBe(false);
    expect(isCompatibleReasoningModel('openrouter', 'anthropic/claude-sonnet-5:thinking')).toBe(true);
    expect(isCompatibleReasoningModel('openrouter', 'nvidia/llama-3.3-nemotron-super-49b')).toBe(true);
    expect(isCompatibleReasoningModel('openrouter', 'qwen/qwq-32b')).toBe(true);
    expect(isCompatibleReasoningModel('xiaomi', 'mimo-v2-pro')).toBe(true);
    expect(isCompatibleReasoningModel('xiaomi', 'mimo-v2-omni')).toBe(true);
    expect(isCompatibleReasoningModel('xiaomi', 'mimo-v2-flash')).toBe(false);
    expect(isCompatibleReasoningModel('xiaomi', 'mimo-v2.5')).toBe(true);
    expect(isCompatibleReasoningModel('xiaomi', 'mimo-v2.5-pro')).toBe(true);
    expect(isCompatibleReasoningModel('xiaomi-token-plan', 'mimo-v2-pro')).toBe(true);
    expect(isCompatibleReasoningModel('xiaomi-token-plan', 'mimo-v2-omni')).toBe(true);
    expect(isCompatibleReasoningModel('xiaomi-token-plan', 'mimo-v2-flash')).toBe(false);
  });

  it('adds default thinking headroom to requestedOutputTokens when effort is undefined', async () => {
    const { GeminiAdapter } = await import('./gemini/adapter.js');
    const { OpenAIAdapter } = await import('./openai/adapter.js');
    const { OpenAICompatibleAdapter } = await import('./compatible/adapter.js');
    const { Secret } = await import('../credentials/secret.js');
    const typeCast = <T>(val: unknown): T => val as T;

    const fakeKey = new Secret('fake-test-key-12345');
    const gemini = new GeminiAdapter({ apiKey: fakeKey, client: typeCast({}) });
    // Gemini 3.8 Flash default thinking adds 8192
    expect(gemini.requestedOutputTokens({ model: 'gemini-3.8-flash', maxOutputTokens: 4096 })).toBe(4096 + 8192);
    // Gemini 2.0 Flash (non-thinking) does not add headroom
    expect(gemini.requestedOutputTokens({ model: 'gemini-2.0-flash', maxOutputTokens: 4096 })).toBe(4096);

    const openai = new OpenAIAdapter({ apiKey: fakeKey, client: typeCast({}) });
    // OpenAI gpt-5 default thinking adds 8192
    expect(openai.requestedOutputTokens({ model: 'gpt-5', maxOutputTokens: 4096 })).toBe(4096 + 8192);
    // OpenAI o3-mini default thinking adds 8192
    expect(openai.requestedOutputTokens({ model: 'o3-mini', maxOutputTokens: 4096 })).toBe(4096 + 8192);
    // OpenAI gpt-4o does not add headroom
    expect(openai.requestedOutputTokens({ model: 'gpt-4o', maxOutputTokens: 4096 })).toBe(4096);

    const deepseek = new OpenAICompatibleAdapter({ provider: 'deepseek', apiKey: fakeKey });
    // DeepSeek reasoner and V4 think at effort high by default: they reserve the `high` budget
    expect(deepseek.requestedOutputTokens({ model: 'deepseek-reasoner', maxOutputTokens: 4096 })).toBe(4096 + 16384);
    expect(deepseek.requestedOutputTokens({ model: 'deepseek-v4-pro', maxOutputTokens: 4096 })).toBe(4096 + 16384);
    // Canonical ids think by default too, and a configured effort is sized as the mapped one.
    expect(deepseek.requestedOutputTokens({ model: 'deepseek-flash', maxOutputTokens: 4096 })).toBe(4096 + 16384);
    expect(deepseek.requestedOutputTokens({ model: 'deepseek-flash', maxOutputTokens: 4096, effort: 'medium' })).toBe(4096 + 16384);
    expect(deepseek.requestedOutputTokens({ model: 'deepseek-flash', maxOutputTokens: 4096, effort: 'off' })).toBe(4096);
    // DeepSeek chat does not add headroom
    expect(deepseek.requestedOutputTokens({ model: 'deepseek-chat', maxOutputTokens: 4096 })).toBe(4096);

    const xiaomi = new OpenAICompatibleAdapter({ provider: 'xiaomi', apiKey: fakeKey });
    // Xiaomi mimo-v2-pro reasons by default and adds 8192
    expect(xiaomi.requestedOutputTokens({ model: 'mimo-v2-pro', maxOutputTokens: 4096 })).toBe(4096 + 8192);
    // Xiaomi mimo-v2-omni reasons by default and adds 8192
    expect(xiaomi.requestedOutputTokens({ model: 'mimo-v2-omni', maxOutputTokens: 4096 })).toBe(4096 + 8192);
    // Xiaomi mimo-v2-flash does not reason by default
    expect(xiaomi.requestedOutputTokens({ model: 'mimo-v2-flash', maxOutputTokens: 4096 })).toBe(4096);
  });
});

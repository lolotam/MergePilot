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

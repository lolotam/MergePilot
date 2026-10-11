import { describe, expect, it, vi } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { EnvCredentialStore, MissingCredentialError } from '../credentials/store.js';
import { LlmFailure } from '../llm/failure.js';
import { ClaudeCodeRunner } from './claude-code/runner.js';
import { OpenAIAdapter } from './openai/adapter.js';
import { createReviewModel } from './factory.js';

describe('createReviewModel', () => {
  const fakeCwd = '/test/workspace';

  it('creates an Anthropic review model with correct label', async () => {
    const store = new EnvCredentialStore({
      ANTHROPIC_API_KEY: 'sk-ant-test-key-123',
    });
    const config: MergePilotConfig = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      language: 'en',
      review: {
        maxFindings: 5,
        minSeverity: 'medium',
        exclude: [],
        rulesFiles: [],
        pathInstructions: [],
      },
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 200000,
      },
      audit: {
        enabled: false,
      },
    };

    const model = await createReviewModel(config, store, { cwd: fakeCwd });
    expect(model.label).toBe('anthropic:claude-3-5-sonnet-20241022');
    expect(typeof model.generate).toBe('function');
  });

  it('creates an OpenAI review model with correct label', async () => {
    const store = new EnvCredentialStore({
      OPENAI_API_KEY: 'sk-test-openai-key-456',
    });
    const config: MergePilotConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      language: 'en',
      review: {
        maxFindings: 5,
        minSeverity: 'medium',
        exclude: [],
        rulesFiles: [],
        pathInstructions: [],
      },
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 200000,
      },
      audit: {
        enabled: false,
      },
    };

    const model = await createReviewModel(config, store, { cwd: fakeCwd });
    expect(model.label).toBe('openai:gpt-4o');
    expect(typeof model.generate).toBe('function');
  });

  it('creates a Gemini review model with correct label', async () => {
    const store = new EnvCredentialStore({
      GEMINI_API_KEY: 'test-gemini-key-789',
    });
    const config: MergePilotConfig = {
      provider: 'gemini',
      model: 'gemini-1.5-pro',
      language: 'ar',
      review: {
        maxFindings: 5,
        minSeverity: 'medium',
        exclude: [],
        rulesFiles: [],
        pathInstructions: [],
      },
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 200000,
      },
      audit: {
        enabled: false,
      },
    };

    const model = await createReviewModel(config, store, { cwd: fakeCwd });
    expect(model.label).toBe('gemini:gemini-1.5-pro');
    expect(typeof model.generate).toBe('function');
  });

  it('creates a ClaudeCodeRunner for claude-code provider', async () => {
    const store = new EnvCredentialStore({
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
    });
    const config: MergePilotConfig = {
      provider: 'claude-code',
      model: 'claude-3-5-sonnet',
      language: 'en',
      review: {
        maxFindings: 5,
        minSeverity: 'medium',
        exclude: [],
        rulesFiles: [],
        pathInstructions: [],
      },
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 200000,
      },
      audit: {
        enabled: false,
      },
    };

    const model = await createReviewModel(config, store, { cwd: fakeCwd });
    expect(model.label).toBe('claude-code');
    expect(model).toBeInstanceOf(ClaudeCodeRunner);
  });

  it('propagates MissingCredentialError when key is missing and never falls back', async () => {
    const store = new EnvCredentialStore({});
    const config: MergePilotConfig = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      language: 'en',
      review: {
        maxFindings: 5,
        minSeverity: 'medium',
        exclude: [],
        rulesFiles: [],
        pathInstructions: [],
      },
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 200000,
      },
      audit: {
        enabled: false,
      },
    };

    await expect(createReviewModel(config, store, { cwd: fakeCwd })).rejects.toThrow(
      MissingCredentialError,
    );
  });

  it('wraps generate with withRetry for API adapters', async () => {
    const store = new EnvCredentialStore({
      OPENAI_API_KEY: 'sk-test-openai',
    });
    const config: MergePilotConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      language: 'en',
      review: {
        maxFindings: 5,
        minSeverity: 'medium',
        exclude: [],
        rulesFiles: [],
        pathInstructions: [],
      },
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 200000,
      },
      audit: {
        enabled: false,
      },
    };

    const model = await createReviewModel(config, store, { cwd: fakeCwd });

    // Spy on OpenAIAdapter.prototype.stream to fail with rate limit once then succeed
    let streamCalls = 0;
    vi.spyOn(OpenAIAdapter.prototype, 'stream').mockImplementation(async function* () {
      streamCalls++;
      if (streamCalls === 1) {
        throw new LlmFailure({
          code: 'RATE_LIMIT',
          provider: 'openai',
          message: 'Rate limit exceeded',
          retryAfterMs: 1,
        });
      }
      yield { type: 'text-delta', text: '{"summary":"All good","findings":[]}' };
      yield { type: 'finish', reason: 'stop' };
    });

    const res = await model.generate({
      system: 'sys',
      user: 'usr',
      maxOutputTokens: 100,
    });
    expect(res.text).toBe('{"summary":"All good","findings":[]}');
    expect(streamCalls).toBe(2);
  });

  it('throws on unsupported provider without falling back', async () => {
    const store = new EnvCredentialStore({});
    const config = {
      provider: 'unsupported-provider' as unknown as MergePilotConfig['provider'],
      model: 'test',
      language: 'en',
      review: {
        maxFindings: 5,
        minSeverity: 'medium',
        exclude: [],
        rulesFiles: [],
        pathInstructions: [],
      },
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 200000,
      },
      audit: {
        enabled: false,
      },
    } as MergePilotConfig;

    await expect(createReviewModel(config, store, { cwd: fakeCwd })).rejects.toThrow(
      /unsupported provider/i,
    );
  });
});

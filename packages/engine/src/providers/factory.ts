import type { MergePilotConfig } from '../config/schema.js';
import type { CredentialStore } from '../credentials/store.js';
import type { LlmAdapter } from '../llm/adapter.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../llm/retry.js';
import { modelFromAdapter, type ReviewModel } from '../review/model.js';
import { AnthropicAdapter } from './anthropic/adapter.js';
import { ClaudeCodeRunner } from './claude-code/runner.js';
import { GeminiAdapter } from './gemini/adapter.js';
import { OpenAIAdapter } from './openai/adapter.js';

export interface CreateReviewModelOptions {
  cwd: string;
  /** claude-code only: isolated CLAUDE_CONFIG_DIR so no runner-level settings or hooks apply. */
  configDir?: string;
}

/**
 * Creates a ReviewModel for the given config and credential store.
 * Never falls back to another provider or model.
 */
export async function createReviewModel(
  config: MergePilotConfig,
  store: CredentialStore,
  opts: CreateReviewModelOptions,
): Promise<ReviewModel> {
  if (config.provider === 'claude-code') {
    const token = await store.resolve({ provider: 'claude-code' }, 'review');
    return new ClaudeCodeRunner({
      token,
      cwd: opts.cwd,
      ...(config.model ? { model: config.model } : {}),
      ...(opts.configDir ? { configDir: opts.configDir } : {}),
    });
  }

  let adapter: LlmAdapter;
  if (config.provider === 'anthropic') {
    const apiKey = await store.resolve({ provider: 'anthropic' }, 'review');
    adapter = new AnthropicAdapter({ apiKey });
  } else if (config.provider === 'openai') {
    const apiKey = await store.resolve({ provider: 'openai' }, 'review');
    adapter = new OpenAIAdapter({ apiKey });
  } else if (config.provider === 'gemini') {
    const apiKey = await store.resolve({ provider: 'gemini' }, 'review');
    adapter = new GeminiAdapter({ apiKey });
  } else {
    throw new Error(`Unsupported provider: ${String(config.provider)}`);
  }

  if (!config.model) {
    throw new Error(`Model is required for provider: ${config.provider}`);
  }

  const baseModel = modelFromAdapter(adapter, config.model);
  const retryPolicy = adapter.retryPolicy ?? DEFAULT_RETRY_POLICY;

  return {
    label: baseModel.label,
    generate(request) {
      return withRetry(
        () => baseModel.generate(request),
        retryPolicy,
        request.signal
          ? {
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              random: Math.random,
              signal: request.signal,
            }
          : undefined,
      );
    },
  };
}

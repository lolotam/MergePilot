import { describe, expect, it } from 'vitest';
import { credentialEnvName, EnvCredentialStore } from '../credentials/store.js';
import { FALLBACK_EFFORTS } from './effort.js';
import { API_PROVIDER_IDS, isApiProviderId, PROVIDER_IDS } from './ids.js';
import { chatModelsFor, listProviders, PROVIDER_REGISTRY, providerEntry, resolveBaseUrl } from './registry.js';

describe('provider registry', () => {
  it('has one entry for every API provider id, natives and compatible presets', () => {
    expect([...API_PROVIDER_IDS].sort()).toEqual(
      [
        'anthropic',
        'openai',
        'gemini',
        'xai',
        'deepseek',
        'nvidia',
        'openrouter',
        'vercel-gateway',
        'opencode-zen',
        'opencode-go',
        'zai',
        'zai-coding',
        'custom',
        'xiaomi',
        'xiaomi-token-plan',
        'xiaomi-token-plan-cn',
      ].sort(),
    );
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([...API_PROVIDER_IDS].sort());
    expect(listProviders().map((p) => p.id)).toEqual([...API_PROVIDER_IDS]);
    expect(PROVIDER_IDS).toContain('claude-code');
    expect(isApiProviderId('claude-code')).toBe(false);
    expect(isApiProviderId('xai')).toBe(true);
    expect(isApiProviderId('xiaomi')).toBe(true);
    expect(isApiProviderId('xiaomi-token-plan')).toBe(true);
  });

  it('gives every entry its id, label, kind, base URL, thinking style and env name', () => {
    for (const entry of listProviders()) {
      expect(entry.id).toBe(entry.id.trim());
      expect(entry.label.length).toBeGreaterThan(0);
      expect(['native', 'openai-compatible']).toContain(entry.kind);
      expect(entry.baseUrl).toMatch(/^https?:\/\//);
      expect(Object.keys(FALLBACK_EFFORTS)).toContain(entry.thinkingStyle);
      expect(entry.envName).toMatch(/^[A-Z_]+$/);
      if (entry.id !== 'custom') expect(entry.defaultModel.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(PROVIDER_REGISTRY)).toBe(true);
  });

  it('marks the three SDK providers native and the presets openai-compatible', () => {
    const natives = listProviders().filter((p) => p.kind === 'native').map((p) => p.id);
    expect(natives).toEqual(['anthropic', 'openai', 'gemini']);
    expect(providerEntry('zai').thinkingStyle).toBe('glm');
    expect(providerEntry('deepseek').thinkingStyle).toBe('deepseek');
    expect(providerEntry('anthropic').keyHint).toBe('sk-ant-');
    expect(providerEntry('openrouter').keyHint).toBe('sk-or-');
    expect(providerEntry('xiaomi').keyHint).toBe('sk-');
    expect(providerEntry('xiaomi-token-plan').keyHint).toBe('tp-');
    expect(providerEntry('xiaomi').label).toBe('Xiaomi MiMo');
    expect(providerEntry('xiaomi-token-plan').label).toBe('Xiaomi MiMo Token Plan (Singapore)');
  });

  it('adds Vercel AI Gateway as an OpenAI-compatible preset with a fixed URL (ADR-0008 amendment)', () => {
    expect(isApiProviderId('vercel-gateway')).toBe(true);
    expect(providerEntry('vercel-gateway')).toEqual({
      id: 'vercel-gateway',
      label: 'Vercel AI Gateway',
      kind: 'openai-compatible',
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
      thinkingStyle: 'reasoning_effort',
      defaultModel: 'anthropic/claude-sonnet-4.5',
      envName: 'AI_GATEWAY_API_KEY',
      requiresBaseUrl: false,
      streamUsage: true,
    });
    expect(resolveBaseUrl('vercel-gateway', 'https://proxy.example/v1')).toBe('https://ai-gateway.vercel.sh/v1');
    expect(credentialEnvName('vercel-gateway')).toBe('AI_GATEWAY_API_KEY');
  });

  it('drops batch-only variants and the Jev judge model from the Vercel chat list', () => {
    const models = ['openai/gpt-5', 'openai/gpt-5-batch', 'typesafe-ai/jev', 'anthropic/claude-sonnet-4.5'].map((id) => ({ id }));
    expect(chatModelsFor('vercel-gateway', models).map((m) => m.id)).toEqual(['openai/gpt-5', 'anthropic/claude-sonnet-4.5']);
  });

  it('requires a base URL only for custom and never overrides a preset', () => {
    expect(providerEntry('custom').requiresBaseUrl).toBe(true);
    expect(() => resolveBaseUrl('custom')).toThrow('requires a base URL');
    expect(resolveBaseUrl('custom', 'http://10.0.0.5:8000/v1/')).toBe('http://10.0.0.5:8000/v1');
    expect(resolveBaseUrl('xai')).toBe('https://api.x.ai/v1');
    // A preset never takes an override: a key must not be sent to another URL.
    expect(resolveBaseUrl('xai', 'https://proxy.example/v1')).toBe('https://api.x.ai/v1');
    expect(resolveBaseUrl('xiaomi')).toBe('https://api.xiaomimimo.com/v1');
    expect(resolveBaseUrl('xiaomi', 'https://proxy.example/v1')).toBe('https://api.xiaomimimo.com/v1');
    expect(resolveBaseUrl('xiaomi-token-plan')).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
    expect(resolveBaseUrl('xiaomi-token-plan', 'https://proxy.example/v1')).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
    expect(resolveBaseUrl('xiaomi-token-plan-cn')).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    expect(resolveBaseUrl('xiaomi-token-plan-cn', 'https://proxy.example/v1')).toBe('https://token-plan-cn.xiaomimimo.com/v1');
  });

  it('drops OpenCode model families that are not served on /chat/completions', () => {
    const models = ['glm-5.3', 'gpt-5', 'claude-sonnet-5', 'qwen3.8-flash', 'kimi-k2'].map((id) => ({ id }));
    expect(chatModelsFor('opencode-zen', models).map((m) => m.id)).toEqual(['glm-5.3', 'kimi-k2']);
    expect(chatModelsFor('opencode-go', models).map((m) => m.id)).toEqual(['glm-5.3', 'kimi-k2']);
    expect(chatModelsFor('xai', models)).toHaveLength(5);
  });

  it('maps every provider to an env var and EnvCredentialStore reads it', async () => {
    expect(credentialEnvName('xai')).toBe('XAI_API_KEY');
    expect(credentialEnvName('opencode-zen')).toBe(credentialEnvName('opencode-go'));
    expect(credentialEnvName('claude-code')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(credentialEnvName('xiaomi')).toBe('XIAOMI_API_KEY');
    expect(credentialEnvName('xiaomi-token-plan')).toBe('XIAOMI_TOKEN_PLAN_API_KEY');
    expect(credentialEnvName('xiaomi-token-plan-cn')).toBe('XIAOMI_TOKEN_PLAN_API_KEY');
    const store = new EnvCredentialStore({ DEEPSEEK_API_KEY: 'k1' });
    expect(await store.info({ provider: 'deepseek' })).toEqual({
      provider: 'deepseek',
      configured: true,
      source: 'env',
      envName: 'DEEPSEEK_API_KEY',
    });
    expect((await store.resolve({ provider: 'deepseek' }, 'review')).reveal()).toBe('k1');
    expect((await store.info({ provider: 'nvidia' })).configured).toBe(false);
  });
});

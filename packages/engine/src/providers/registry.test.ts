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
        'opencode-zen',
        'opencode-go',
        'zai',
        'zai-coding',
        'custom',
      ].sort(),
    );
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([...API_PROVIDER_IDS].sort());
    expect(listProviders().map((p) => p.id)).toEqual([...API_PROVIDER_IDS]);
    expect(PROVIDER_IDS).toContain('claude-code');
    expect(isApiProviderId('claude-code')).toBe(false);
    expect(isApiProviderId('xai')).toBe(true);
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
    expect(providerEntry('deepseek').thinkingStyle).toBe('none');
    expect(providerEntry('anthropic').keyHint).toBe('sk-ant-');
    expect(providerEntry('openrouter').keyHint).toBe('sk-or-');
  });

  it('requires a base URL only for custom', () => {
    expect(providerEntry('custom').requiresBaseUrl).toBe(true);
    expect(() => resolveBaseUrl('custom')).toThrow('requires a base URL');
    expect(resolveBaseUrl('custom', 'http://10.0.0.5:8000/v1/')).toBe('http://10.0.0.5:8000/v1');
    expect(resolveBaseUrl('xai')).toBe('https://api.x.ai/v1');
    expect(resolveBaseUrl('xai', 'https://proxy.example/v1')).toBe('https://proxy.example/v1');
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
    const store = new EnvCredentialStore({ DEEPSEEK_API_KEY: 'sk-test-000' });
    expect(await store.info({ provider: 'deepseek' })).toEqual({
      provider: 'deepseek',
      configured: true,
      source: 'env',
      envName: 'DEEPSEEK_API_KEY',
    });
    expect((await store.resolve({ provider: 'deepseek' }, 'review')).reveal()).toBe('sk-test-000');
    expect((await store.info({ provider: 'nvidia' })).configured).toBe(false);
  });
});

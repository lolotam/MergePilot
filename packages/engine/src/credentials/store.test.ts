import { describe, expect, it } from 'vitest';
import { EnvCredentialStore, MissingCredentialError, SubscriptionEnvelopeError } from './store.js';
import { encodeSubscription, SUBSCRIPTION_PREFIX } from './subscription.js';
import type { CredentialProvider } from './types.js';

describe('EnvCredentialStore', () => {
  const sampleEnv = {
    ANTHROPIC_API_KEY: '  sk-ant-test-000  ',
    OPENAI_API_KEY: 'sk-test-000',
    GEMINI_API_KEY: 'AIzaSyTest000',
    CLAUDE_CODE_OAUTH_TOKEN: 'cc-oauth-test-000',
  };

  it('reports configured info without revealing the secret value', async () => {
    const store = new EnvCredentialStore(sampleEnv);
    const info = await store.info({ provider: 'anthropic' });

    expect(info).toEqual({
      provider: 'anthropic',
      configured: true,
      source: 'env',
      envName: 'ANTHROPIC_API_KEY',
    });
    expect(info).not.toHaveProperty('value');
    expect(info).not.toHaveProperty('secret');
  });

  it('reports unconfigured info for missing env variables', async () => {
    const store = new EnvCredentialStore({});
    const info = await store.info({ provider: 'openai' });

    expect(info).toEqual({
      provider: 'openai',
      configured: false,
      source: 'none',
      envName: 'OPENAI_API_KEY',
    });
  });

  it('reports unconfigured info for blank env variables', async () => {
    const store = new EnvCredentialStore({ GEMINI_API_KEY: '   ' });
    const info = await store.info({ provider: 'gemini' });

    expect(info).toEqual({
      provider: 'gemini',
      configured: false,
      source: 'none',
      envName: 'GEMINI_API_KEY',
    });
  });

  it('maps each provider to its correct env name', async () => {
    const store = new EnvCredentialStore({});
    const providers: Array<{ provider: CredentialProvider; envName: string }> = [
      { provider: 'anthropic', envName: 'ANTHROPIC_API_KEY' },
      { provider: 'openai', envName: 'OPENAI_API_KEY' },
      { provider: 'gemini', envName: 'GEMINI_API_KEY' },
      { provider: 'claude-code', envName: 'CLAUDE_CODE_OAUTH_TOKEN' },
    ];

    for (const { provider, envName } of providers) {
      const info = await store.info({ provider });
      expect(info.envName).toBe(envName);
    }
  });

  it('resolves a configured credential and trims its value', async () => {
    const store = new EnvCredentialStore(sampleEnv);
    const secret = await store.resolve({ provider: 'anthropic' }, 'review');

    expect(secret.reveal()).toBe('sk-ant-test-000');
  });

  it('resolves with validate-connection purpose', async () => {
    const store = new EnvCredentialStore(sampleEnv);
    const secret = await store.resolve({ provider: 'claude-code' }, 'validate-connection');

    expect(secret.reveal()).toBe('cc-oauth-test-000');
  });

  it('throws MissingCredentialError when env var is missing and names the var without leaking values', async () => {
    const store = new EnvCredentialStore({});

    await expect(store.resolve({ provider: 'openai' }, 'review')).rejects.toThrow(
      MissingCredentialError,
    );

    try {
      await store.resolve({ provider: 'openai' }, 'review');
      expect.unreachable('Should have thrown MissingCredentialError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingCredentialError);
      const missingErr = err as MissingCredentialError;
      expect(missingErr.envName).toBe('OPENAI_API_KEY');
      expect(missingErr.message).toContain('OPENAI_API_KEY');
      expect(missingErr.message).not.toContain('undefined');
    }
  });

  it('throws MissingCredentialError when env var is blank and leaks nothing', async () => {
    const store = new EnvCredentialStore({ ANTHROPIC_API_KEY: '   ' });

    try {
      await store.resolve({ provider: 'anthropic' }, 'review');
      expect.unreachable('Should have thrown MissingCredentialError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingCredentialError);
      const missingErr = err as MissingCredentialError;
      expect(missingErr.envName).toBe('ANTHROPIC_API_KEY');
      expect(missingErr.message).toContain('ANTHROPIC_API_KEY');
    }
  });

  describe('subscription envelopes (ADR-0038)', () => {
    const credential = { type: 'oauth' as const, access: 'access-tok-000', refresh: 'refresh-tok-000', expires: Date.now() + 3_600_000 };

    it.each([
      { provider: 'anthropic', envName: 'ANTHROPIC_API_KEY' },
      { provider: 'openai', envName: 'OPENAI_API_KEY' },
      { provider: 'xai', envName: 'XAI_API_KEY' },
      { provider: 'google-antigravity', envName: 'GOOGLE_ANTIGRAVITY_SUBSCRIPTION' },
    ] as const)('rejects an unexpired $provider envelope in $envName and names the supported inputs', async ({ provider, envName }) => {
      const envelope = encodeSubscription(provider, credential);
      const store = new EnvCredentialStore({ [envName]: `  ${envelope}  ` });

      const error = await store.resolve({ provider }, 'review').then(() => undefined, (err: unknown) => err);

      expect(error).toBeInstanceOf(SubscriptionEnvelopeError);
      expect(error).toBeInstanceOf(MissingCredentialError);
      const envelopeError = error as SubscriptionEnvelopeError;
      expect(envelopeError.envName).toBe(envName);
      expect(envelopeError.message).toContain(envName);
      expect(envelopeError.message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(envelopeError.message).toContain('GitHub App');
      expect(envelopeError.message).not.toContain('access-tok-000');
      expect(envelopeError.message).not.toContain('refresh-tok-000');
      expect(envelopeError.message).not.toContain(SUBSCRIPTION_PREFIX);
    });

    it('rejects on the prefix alone, without decoding the rest', async () => {
      const store = new EnvCredentialStore({ ANTHROPIC_API_KEY: `${SUBSCRIPTION_PREFIX}not-json` });

      await expect(store.resolve({ provider: 'anthropic' }, 'review')).rejects.toBeInstanceOf(SubscriptionEnvelopeError);
    });

    it('still reports the variable as configured, so the primary path reaches the clear message', async () => {
      const store = new EnvCredentialStore({ ANTHROPIC_API_KEY: encodeSubscription('anthropic', credential) });

      expect(await store.info({ provider: 'anthropic' })).toMatchObject({ configured: true, envName: 'ANTHROPIC_API_KEY' });
    });

    it('leaves the raw claude-code token alone', async () => {
      const store = new EnvCredentialStore({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-000' });

      expect((await store.resolve({ provider: 'claude-code' }, 'review')).reveal()).toBe('sk-ant-oat01-test-000');
    });
  });

  it('defaults to process.env when no env record is provided', async () => {
    const prev = process.env['OPENAI_API_KEY'];
    try {
      process.env['OPENAI_API_KEY'] = 'sk-test-from-process-env';
      const store = new EnvCredentialStore();
      const secret = await store.resolve({ provider: 'openai' }, 'review');
      expect(secret.reveal()).toBe('sk-test-from-process-env');
    } finally {
      if (prev !== undefined) {
        process.env['OPENAI_API_KEY'] = prev;
      } else {
        delete process.env['OPENAI_API_KEY'];
      }
    }
  });
});

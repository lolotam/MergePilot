import { describe, expect, it, vi } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { Secret } from '../credentials/secret.js';
import type { AnyCredentialStore, CredentialInfo } from '../credentials/store.js';
import { encodeSubscription } from '../credentials/subscription.js';
import { LlmFailure } from '../llm/failure.js';
import { redactSecrets } from '../security/redact.js';
import type { ReviewAuthMethod } from '../review/model.js';
import { createReviewModel } from './factory.js';
import type { KeyRoster } from './model-builders.js';

type Dual = 'openai' | 'anthropic' | 'xai';

const envelope = (provider: Dual) =>
  new Secret(
    encodeSubscription(provider, {
      type: 'oauth',
      access: `${provider}-access-token-test`,
      refresh: `${provider}-refresh-token-test`,
      expires: Date.now() + 3_600_000,
      accountId: 'acct',
    }),
  );

const keys = (provider: Dual) => [new Secret(`${provider}-api-key-one`), new Secret(`${provider}-api-key-two`)];

interface Workspace {
  defaults: Partial<Record<Dual, ReviewAuthMethod>>;
  subscriptions: Partial<Record<Dual, Secret>>;
  rosters: Partial<Record<Dual, readonly Secret[]>>;
}

/**
 * Behaves like the worker's WorkspaceCredentialStore: a plain resolve answers with the effective
 * default (a key from the roster when keys are the default), and only `method: 'subscription'`
 * returns the subscription envelope.
 */
function workspaceStore(ws: Workspace): AnyCredentialStore {
  return {
    async info({ provider }): Promise<CredentialInfo> {
      return { configured: provider in ws.defaults, provider } as CredentialInfo;
    },
    async resolve({ provider, method }) {
      const p = provider as Dual;
      if (method === 'subscription') {
        const sub = ws.subscriptions[p];
        if (!sub) throw new Error('no subscription');
        return sub;
      }
      const secret = ws.defaults[p] === 'api-key' ? ws.rosters[p]?.[0] : ws.subscriptions[p];
      if (!secret) throw new Error('missing');
      return secret;
    },
  };
}

const rostersOf = (ws: Workspace): Record<string, KeyRoster> =>
  Object.fromEntries(Object.entries(ws.rosters).map(([provider, list]) => [provider, { keys: list ?? [], startIndex: 0 }]));

const config = (provider: Dual, model: string, extra: Partial<MergePilotConfig> = {}): MergePilotConfig => ({
  provider,
  model,
  language: 'en',
  review: { maxFindings: 5, minSeverity: 'medium', exclude: [], rulesFiles: [], pathInstructions: [] },
  budget: { perReviewUsd: 0.5, maxInputTokens: 200_000 },
  audit: { enabled: false },
  ...extra,
});

async function build(ws: Workspace, cfg: MergePilotConfig) {
  const dualMethods = Object.fromEntries(
    Object.entries(ws.defaults).map(([provider, defaultMethod]) => [provider, { defaultMethod }]),
  );
  return createReviewModel(cfg, workspaceStore(ws), { cwd: '/tmp', dualMethods, keyRosters: rostersOf(ws) });
}

const revealed = (secrets: readonly Secret[] | undefined) => (secrets ?? []).map((s) => s.reveal());

describe('createReviewModel — dual-method chain (ADR-0027)', () => {
  it.each(['default', 'subscription'] as const)('defers an auth failure resolving the primary %s during construction', async (stage) => {
    const ws: Workspace = { defaults: { anthropic: 'subscription', openai: 'api-key' },
      subscriptions: { anthropic: envelope('anthropic') }, rosters: { anthropic: keys('anthropic'), openai: keys('openai') } };
    const store = workspaceStore(ws);
    const original = store.resolve.bind(store);
    const failure = new LlmFailure({ provider: 'anthropic', code: 'INVALID_CREDENTIAL', message: 'Subscription token refresh failed; sign in again' });
    vi.spyOn(store, 'resolve').mockImplementation(async (ref, purpose) => {
      if (ref.provider === 'anthropic' && (stage === 'default' || ref.method === 'subscription')) throw failure;
      return original(ref, purpose);
    });
    const model = await createReviewModel(config('anthropic', 'claude-3-5-sonnet', {
      fallback: [{ provider: 'openai', model: 'gpt-5' }],
    }), store, { cwd: '/tmp', dualMethods: { anthropic: { defaultMethod: 'subscription' } }, keyRosters: rostersOf(ws) });

    expect(model).toMatchObject({ authMethod: 'subscription', includedInSubscription: true });
    await expect(model.generate({ system: '', user: '', maxOutputTokens: 100 })).rejects.toBe(failure);
    expect(model.fallbacks?.map((entry) => entry.label)).toEqual(['anthropic:claude-3-5-sonnet', 'openai:gpt-5']);
    expect(model.fallbacks?.[0]?.fallbackTriggers).toEqual(['quota', 'rate-limit']);
  });

  it.each([new Error('stored credential unavailable'), new LlmFailure({ provider: 'anthropic', code: 'NETWORK', message: 'provider unreachable' })])(
    'propagates a non-auth construction failure: %s', async (failure) => {
      const store = workspaceStore({ defaults: {}, subscriptions: {}, rosters: {} });
      vi.spyOn(store, 'resolve').mockRejectedValue(failure);
      await expect(createReviewModel(config('anthropic', 'claude-3-5-sonnet'), store, { cwd: '/tmp' })).rejects.toBe(failure);
    },
  );

  it('defers an unavailable primary subscription to its first call without resolving it again', async () => {
    const ws: Workspace = { defaults: { anthropic: 'subscription', openai: 'api-key' },
      subscriptions: {}, rosters: { anthropic: keys('anthropic'), openai: keys('openai') } };
    const store = workspaceStore(ws);
    const resolve = vi.spyOn(store, 'resolve');
    const failure = new LlmFailure({ provider: 'anthropic', code: 'INVALID_CREDENTIAL', message: 'Subscription token refresh failed; sign in again' });
    const model = await createReviewModel(config('anthropic', 'claude-3-5-sonnet', {
      fallback: [{ provider: 'openai', model: 'gpt-5' }],
    }), store, { cwd: '/tmp', primarySubscriptionFailure: failure,
      dualMethods: { anthropic: { defaultMethod: 'subscription' } }, keyRosters: rostersOf(ws) });

    expect(model).toMatchObject({ label: 'anthropic:claude-3-5-sonnet', authMethod: 'subscription', includedInSubscription: true });
    await expect(model.generate({ system: '', user: '', maxOutputTokens: 100 })).rejects.toBe(failure);
    expect(model.fallbacks?.map((entry) => entry.label)).toEqual(['anthropic:claude-3-5-sonnet', 'openai:gpt-5']);
    expect(model.fallbacks?.[0]?.fallbackTriggers).toEqual(['quota', 'rate-limit']);
    expect(resolve.mock.calls.some(([ref]) => ref.provider === 'anthropic')).toBe(false);
    expect(model.secrets).toEqual(expect.arrayContaining([...ws.rosters.anthropic!, ...ws.rosters.openai!]));
  });

  it('keeps unavailable configured fallbacks skipped after checking their credentials', async () => {
    const ws: Workspace = { defaults: { openai: 'subscription' }, subscriptions: { openai: envelope('openai') }, rosters: {} };
    const store = workspaceStore(ws);
    const info = vi.spyOn(store, 'info');
    const resolve = vi.spyOn(store, 'resolve');
    const model = await createReviewModel(config('openai', 'gpt-5', {
      fallback: [{ provider: 'custom', model: 'one' }, { provider: 'custom', model: 'two' }, { provider: 'openai', model: 'gpt-4' }],
    }), store, { cwd: '/tmp', skipFallback: (entry) => entry.provider === 'custom' ? 'excluded by caller' : undefined });
    expect(model.skippedFallbacks).toEqual([
      { label: 'custom:one', reason: 'excluded by caller' },
      { label: 'custom:two', reason: 'excluded by caller' },
    ]);
    expect(info.mock.calls.some(([ref]) => ref.provider === 'custom')).toBe(true);
    expect(resolve.mock.calls.some(([ref]) => ref.provider === 'custom')).toBe(false);
    expect(model.fallbacks?.map((entry) => entry.label)).toEqual(['openai:gpt-4']);
  });
  it('keeps a skipped fallback key and every roster key for redaction without building its model', async () => {
    const roster = keys('anthropic');
    const key = new Secret('anthropic-skipped-single-key');
    const ws: Workspace = { defaults: { openai: 'subscription', anthropic: 'api-key' },
      subscriptions: { openai: envelope('openai') }, rosters: { anthropic: [key] } };
    const model = await createReviewModel(config('openai', 'gpt-5', {
      fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    }), workspaceStore(ws), { cwd: '/tmp', keyRosters: { anthropic: { keys: roster, startIndex: 0 } }, skipFallback: () => 'excluded by caller' });
    expect(model.fallbacks).toBeUndefined();
    expect(model.secrets).toEqual(expect.arrayContaining([key, ...roster]));
    expect(model.skippedFallbacks).toEqual([{ label: 'anthropic:claude-sonnet-5-5', reason: 'excluded by caller' }]);
  });

  it.each([false, true])('keeps a fallback skipped when its key cannot be resolved (roster=%s)', async (withRoster) => {
    const roster = keys('anthropic');
    const primary = envelope('openai');
    const ws: Workspace = { defaults: { openai: 'subscription', anthropic: 'api-key' },
      subscriptions: { openai: primary }, rosters: {} };
    const store = workspaceStore(ws);
    const resolve = store.resolve.bind(store);
    vi.spyOn(store, 'resolve').mockImplementation(async (ref, purpose) => {
      if (ref.provider === 'anthropic') throw new Error('unavailable');
      return resolve(ref, purpose);
    });
    const model = await createReviewModel(config('openai', 'gpt-5', {
      fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    }), store, { cwd: '/tmp', skipFallback: () => 'excluded by caller',
      ...(withRoster ? { keyRosters: { anthropic: { keys: roster, startIndex: 0 } } } : {}),
    });
    expect(model.fallbacks).toBeUndefined();
    expect(model.secrets).toEqual(withRoster ? [primary, ...roster] : [primary]);
    expect(model.skippedFallbacks).toEqual([{ label: 'anthropic:claude-sonnet-5-5', reason: 'excluded by caller' }]);
  });

  it.each([false, true])('redacts both methods of a skipped API-default dual provider without building models (key read fails=%s)', async (keyReadFails) => {
    const apiKeys = keys('anthropic');
    const sub = envelope('anthropic');
    const ws: Workspace = { defaults: { openai: 'subscription', anthropic: 'api-key' },
      subscriptions: { openai: envelope('openai'), anthropic: sub }, rosters: { anthropic: apiKeys } };
    const store = workspaceStore(ws);
    const resolve = store.resolve.bind(store);
    vi.spyOn(store, 'resolve').mockImplementation(async (ref, purpose) => {
      if (keyReadFails && ref.provider === 'anthropic' && ref.method !== 'subscription') throw new Error('unavailable');
      return resolve(ref, purpose);
    });
    const model = await createReviewModel(config('openai', 'gpt-5', {
      fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    }), store, { cwd: '/tmp', keyRosters: rostersOf(ws), dualMethods: { anthropic: { defaultMethod: 'api-key' } },
      skipFallback: () => 'excluded by caller' });
    expect(model.fallbacks).toBeUndefined();
    expect(model.secrets).toEqual(expect.arrayContaining([...apiKeys, sub]));
    const prompt = redactSecrets('anthropic-access-token-test anthropic-refresh-token-test', [...model.secrets ?? []]).text;
    expect(prompt).not.toContain('anthropic-access-token-test');
    expect(prompt).not.toContain('anthropic-refresh-token-test');
    expect(model.skippedFallbacks).toEqual([{ label: 'anthropic:claude-sonnet-5-5', reason: 'excluded by caller' }]);
  });

  it('keeps a skipped dual provider skipped when its subscription cannot be read', async () => {
    const apiKeys = keys('anthropic');
    const ws: Workspace = { defaults: { openai: 'subscription', anthropic: 'api-key' },
      subscriptions: { openai: envelope('openai') }, rosters: { anthropic: apiKeys } };
    const model = await createReviewModel(config('openai', 'gpt-5', {
      fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    }), workspaceStore(ws), { cwd: '/tmp', keyRosters: rostersOf(ws), dualMethods: { anthropic: { defaultMethod: 'api-key' } },
      skipFallback: () => 'excluded by caller' });
    expect(model.fallbacks).toBeUndefined();
    expect(model.secrets).toEqual(expect.arrayContaining(apiKeys));
    expect(model.skippedFallbacks).toEqual([{ label: 'anthropic:claude-sonnet-5-5', reason: 'excluded by caller' }]);
  });

  it('puts the rotating API keys right behind a subscription default, and redacts both methods', async () => {
    const ws: Workspace = { defaults: { openai: 'subscription' }, subscriptions: { openai: envelope('openai') }, rosters: { openai: keys('openai') } };
    const model = await build(ws, config('openai', 'gpt-5'));

    expect(model).toMatchObject({ label: 'openai:gpt-5', authMethod: 'subscription', includedInSubscription: true });
    expect(model.fallbacks).toHaveLength(1);
    expect(model.fallbacks?.[0]).toMatchObject({ label: 'openai:gpt-5', authMethod: 'api-key', fallbackTriggers: ['quota', 'rate-limit'] });
    expect(model.fallbacks?.[0]?.includedInSubscription).toBeUndefined();
    expect(revealed(model.secrets)).toEqual(
      expect.arrayContaining([ws.subscriptions.openai!.reveal(), ...keys('openai').map((k) => k.reveal())]),
    );
  });

  it('still fails construction when an API-key default has no keys, even with a configured fallback', async () => {
    const ws: Workspace = { defaults: { anthropic: 'api-key', openai: 'api-key' }, subscriptions: { anthropic: envelope('anthropic') },
      rosters: { anthropic: keys('anthropic'), openai: keys('openai') } };
    // The anthropic roster is missing at construction: buildMethodModel's API-key branch throws an auth LlmFailure.
    const built = createReviewModel(config('anthropic', 'claude-sonnet-5-5', { fallback: [{ provider: 'openai', model: 'gpt-5' }] }),
      workspaceStore(ws), { cwd: '/tmp', dualMethods: { anthropic: { defaultMethod: 'api-key' }, openai: { defaultMethod: 'api-key' } },
        keyRosters: rostersOf({ ...ws, rosters: { openai: ws.rosters.openai } }) });

    await expect(built).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL', message: 'no API key is configured for anthropic' });
  });

  it('puts the subscription behind an API-key default, though a plain resolve returns a key', async () => {
    const ws: Workspace = { defaults: { anthropic: 'api-key' }, subscriptions: { anthropic: envelope('anthropic') }, rosters: { anthropic: keys('anthropic') } };
    const model = await build(ws, config('anthropic', 'claude-sonnet-5-5'));

    expect(model).toMatchObject({ authMethod: 'api-key' });
    expect(model.includedInSubscription).toBeUndefined();
    expect(model.fallbacks?.[0]).toMatchObject({
      label: 'anthropic:claude-sonnet-5-5',
      authMethod: 'subscription',
      includedInSubscription: true,
      fallbackTriggers: ['quota', 'rate-limit'],
    });
    expect(revealed(model.secrets)).toContain(ws.subscriptions.anthropic!.reveal());
  });

  it('gives each dual fallback entry its own other method, in chain order', async () => {
    const ws: Workspace = {
      defaults: { openai: 'subscription', xai: 'api-key' },
      subscriptions: { openai: envelope('openai'), xai: envelope('xai') },
      rosters: { openai: keys('openai'), xai: keys('xai') },
    };
    const model = await build(ws, config('openai', 'gpt-5', { fallback: [{ provider: 'xai', model: 'grok-4' }] }));

    expect(model.fallbacks?.map((m) => [m.label, m.authMethod, m.fallbackTriggers ?? 'all'])).toEqual([
      ['openai:gpt-5', 'api-key', ['quota', 'rate-limit']],
      ['xai:grok-4', 'api-key', 'all'],
      ['xai:grok-4', 'subscription', ['quota', 'rate-limit']],
    ]);
    expect(revealed(model.secrets)).toContain(ws.subscriptions.xai!.reveal());
  });

  it('discloses an other-method entry that cannot be built instead of dropping it', async () => {
    // The store says nothing about a subscription for xai: the API keys stay the only method.
    const ws: Workspace = { defaults: { xai: 'api-key' }, subscriptions: {}, rosters: { xai: keys('xai') } };
    const model = await build(ws, config('xai', 'grok-4'));

    expect(model.fallbacks ?? []).toHaveLength(0);
    expect(model.skippedFallbacks).toEqual([{ label: 'xai:grok-4', reason: 'the subscription could not be set up' }]);
  });

  it('builds no other-method entry for a provider outside dualMethods', async () => {
    const ws: Workspace = {
      defaults: { openai: 'subscription', xai: 'subscription' },
      subscriptions: { openai: envelope('openai'), xai: envelope('xai') },
      rosters: {},
    };
    const cfg = config('openai', 'gpt-5', { fallback: [{ provider: 'xai', model: 'grok-4' }] });
    const model = await createReviewModel(cfg, workspaceStore(ws), { cwd: '/tmp' });

    expect(model.fallbacks?.map((m) => [m.label, m.fallbackTriggers])).toEqual([['xai:grok-4', undefined]]);
  });

  it('keeps the subscription flag on a rotating model over subscription credentials', async () => {
    const sub = envelope('openai');
    const ws: Workspace = { defaults: { openai: 'subscription' }, subscriptions: { openai: sub }, rosters: {} };
    const model = await createReviewModel(config('openai', 'gpt-5'), workspaceStore(ws), {
      cwd: '/tmp',
      keyRosters: { openai: { keys: [sub], startIndex: 0 } },
    });

    expect(model).toMatchObject({ authMethod: 'subscription', includedInSubscription: true });
  });
});

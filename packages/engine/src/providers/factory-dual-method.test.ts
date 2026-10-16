import { describe, expect, it } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { Secret } from '../credentials/secret.js';
import type { AnyCredentialStore, CredentialInfo } from '../credentials/store.js';
import { encodeSubscription } from '../credentials/subscription.js';
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

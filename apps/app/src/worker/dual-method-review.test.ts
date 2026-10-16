import { describe, expect, it, vi } from 'vitest';
import type { DualAuthState } from '../credentials/dual-auth.js';
import type { WorkspaceSettings } from '../core/types.js';
import { dualMethodsForProviders, reviewUsesSubscriptionAdmission, withinAdmission } from './dual-method-review.js';
import { usedModel } from './model-choice.js';
import type { ProcessReviewCredentials } from './types.js';

const state = (overrides: Partial<DualAuthState>): DualAuthState => ({
  hasSubscription: true,
  hasApiKeys: true,
  preference: 'subscription',
  effective: 'subscription',
  ...overrides,
});
const credentials = (dual: DualAuthState | Error): ProcessReviewCredentials => ({
  resolve: vi.fn(),
  getDualAuthState: vi.fn(async () => {
    if (dual instanceof Error) throw dual;
    return dual;
  }),
});

describe('reviewUsesSubscriptionAdmission (ADR-0027)', () => {
  it.each([
    ['a subscription default with API keys is paid: it may fall back to them', state({}), false],
    ['a subscription default with no API keys is free', state({ hasApiKeys: false }), true],
    ['an API-key default is paid', state({ effective: 'api-key' }), false],
    ['a state that cannot be read counts as paid instead of failing the review', new Error('db down'), false],
  ] as const)('%s', async (_scenario, dual, free) => {
    expect(await reviewUsesSubscriptionAdmission(credentials(dual), 'ws', 'openai')).toBe(free);
  });
});

describe('dualMethodsForProviders', () => {
  it('leaves a provider whose state cannot be read on its default method, without failing the review', async () => {
    const creds: ProcessReviewCredentials = {
      resolve: vi.fn(),
      getDualAuthState: vi.fn(async (_ws, provider) => {
        if (provider === 'xai') throw new Error('db down');
        return state({});
      }),
    };
    const logger = { warn: vi.fn() };

    expect(await dualMethodsForProviders(creds, 'ws', ['openai', 'xai'], logger)).toEqual({ openai: { defaultMethod: 'subscription' } });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'credential.dual_state_failed', provider: 'xai' }), expect.any(String));
  });
});

describe('withinAdmission', () => {
  const dual = { openai: { defaultMethod: 'subscription' as const }, xai: { defaultMethod: 'api-key' as const } };

  it('drops the paid keys behind a subscription for a bot admitted as free', () => {
    expect(withinAdmission(dual, true, 'anthropic')).toEqual({ xai: { defaultMethod: 'api-key' } });
  });

  it("drops both methods of a free bot's own provider, though its default switched to API keys (ADR-0033)", () => {
    expect(withinAdmission(dual, true, 'xai')).toEqual({});
  });

  it('keeps every method for a bot that holds its budget', () => {
    expect(withinAdmission(dual, false, 'xai')).toEqual(dual);
  });
});

describe('usedModel after a method-only fallback', () => {
  it('keeps the configured provider, model and effort', () => {
    const choice = { provider: 'openai' as const, model: 'gpt-5', effort: 'high' as string | null, heavy: false };
    const used = usedModel(choice, { fallback: [] } as unknown as WorkspaceSettings, 'openai:gpt-5', 'openai:gpt-5', 'subscription', 'api-key');
    expect(used).toEqual({ provider: 'openai', model: 'gpt-5', effort: 'high', fallbackFrom: 'openai:gpt-5' });
  });
});

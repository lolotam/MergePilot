import { decodeSubscription, type SubscriptionProvider } from '@mergepilot/engine';
import type { AppStore, KeyProvider, ProviderAuthMethod, Vault } from '../core/types.js';
import { effectiveAuthMethod } from './auth-method.js';
import { isDualMethodProvider } from './multi-key.js';
import { parentPlaintext } from './key-list-helpers.js';

export class UnavailableAuthMethodError extends Error {
  constructor(method: ProviderAuthMethod) {
    super(`No ${method === 'subscription' ? 'subscription' : 'API key'} credential is connected for this provider`);
    this.name = 'UnavailableAuthMethodError';
  }
}

export interface DualAuthState {
  hasSubscription: boolean;
  hasApiKeys: boolean;
  preference: ProviderAuthMethod | null;
  effective: ProviderAuthMethod | null;
}

export async function readDualAuthState(
  store: AppStore,
  vault: Vault,
  workspaceId: string,
  provider: KeyProvider,
): Promise<DualAuthState | null> {
  if (!isDualMethodProvider(provider)) return null;
  const parent = await store.getCredential(workspaceId, provider);
  if (!parent) {
    return { hasSubscription: false, hasApiKeys: false, preference: null, effective: null };
  }
  let hasSubscription: boolean;
  try {
    const value = await parentPlaintext(vault, parent);
    hasSubscription = Boolean(decodeSubscription(value, provider as SubscriptionProvider));
  } catch {
    const slotCount = (await store.listProviderKeys(workspaceId, provider)).length;
    const preference = await store.getProviderAuthPreference(workspaceId, provider);
    const hasApiKeys = slotCount > 0;
    // The parent may be a subscription we cannot read: only an explicit API-key choice uses the keys.
    const effective = preference === 'api-key' && hasApiKeys ? 'api-key' : null;
    return { hasSubscription: false, hasApiKeys, preference, effective };
  }
  const slotCount = (await store.listProviderKeys(workspaceId, provider)).length;
  const hasApiKeys = slotCount > 0 || !hasSubscription;
  const preference = await store.getProviderAuthPreference(workspaceId, provider);
  const effective = effectiveAuthMethod(preference, hasSubscription, hasApiKeys);
  return { hasSubscription, hasApiKeys, preference, effective };
}

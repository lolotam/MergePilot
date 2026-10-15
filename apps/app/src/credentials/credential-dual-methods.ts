import type { SubscriptionProvider } from '@mergepilot/engine';
import type { AppStore, KeyProvider, ProviderAuthMethod, StoredCredential, Vault } from '../core/types.js';
import { readDualAuthState, UnavailableAuthMethodError } from './dual-auth.js';
import {
  credentialFromSlot,
  isSubscriptionParentLocked,
  materializeLegacyKeySlot,
} from './key-list-helpers.js';
import { isDualMethodProvider } from './multi-key.js';

export class NoSubscriptionConnectedError extends Error {
  constructor() {
    super('No subscription is connected for this provider');
    this.name = 'NoSubscriptionConnectedError';
  }
}

export async function getEffectiveAuthMethod(
  store: AppStore,
  vault: Vault,
  workspaceId: string,
  provider: KeyProvider,
): Promise<ProviderAuthMethod | null> {
  const dual = await readDualAuthState(store, vault, workspaceId, provider);
  return dual?.effective ?? null;
}

function hasApiKeysInLock(
  slots: ReadonlyArray<unknown>,
  parent: StoredCredential | null,
  isSub: boolean,
): boolean {
  if (slots.length > 0) return true;
  return Boolean(parent && !isSub);
}

export async function setProviderDefaultMethod(
  store: AppStore,
  vault: Vault,
  workspaceId: string,
  provider: KeyProvider,
  method: ProviderAuthMethod,
): Promise<void> {
  if (!isDualMethodProvider(provider)) throw new Error(`Provider "${provider}" stores one credential`);
  await store.modifyProviderKeys(workspaceId, provider, async (current, parent) => {
    const slots = await materializeLegacyKeySlot(vault, parent, current);
    const isSub = await isSubscriptionParentLocked(vault, parent);
    const hasSub = isSub && parent !== null;
    const hasKeys = hasApiKeysInLock(slots, parent, isSub);
    if (method === 'subscription' && !hasSub) throw new UnavailableAuthMethodError(method);
    if (method === 'api-key' && !hasKeys) throw new UnavailableAuthMethodError(method);
    return { keys: slots, authPreference: method };
  });
}

export async function disconnectSubscription(
  store: AppStore,
  vault: Vault,
  workspaceId: string,
  provider: SubscriptionProvider,
): Promise<void> {
  if (!isDualMethodProvider(provider)) throw new Error(`Provider "${provider}" stores one credential`);
  await store.modifyProviderKeys(workspaceId, provider, async (current, parent) => {
    if (!parent || !(await isSubscriptionParentLocked(vault, parent))) {
      throw new NoSubscriptionConnectedError();
    }
    const first = current[0];
    if (first) return { keys: current, parent: credentialFromSlot(first, parent.baseUrl) };
    return { keys: [], parent: null };
  });
}

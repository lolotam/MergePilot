import { decodeSubscription, Secret, type SubscriptionProvider } from '@mergepilot/engine';
import type { AppStore, KeyProvider, StoredCredential, Vault } from '../core/types.js';

/** A stored credential that cannot be used, with no vault or provider error text. */
export class UnavailableCredentialError extends Error {
  constructor(readonly reason: 'missing' | 'undecodable') {
    super('Subscription credential could not be resolved; sign in again');
    this.name = 'UnavailableCredentialError';
  }
}

export async function readStoredSubscription(vault: Vault, stored: StoredCredential | null, workspaceId: string, provider: SubscriptionProvider) {
  if (!stored) throw new UnavailableCredentialError('missing');
  try {
    const value = await vault.decrypt(stored.ciphertext, { workspaceId, provider });
    return { value, subscription: decodeSubscription(value, provider) };
  } catch {
    throw new UnavailableCredentialError('undecodable');
  }
}

export async function readCredentialForRedaction(store: AppStore, vault: Vault, workspaceId: string, provider: KeyProvider): Promise<Secret | null> {
  const stored = await store.getCredential(workspaceId, provider);
  if (!stored) return null;
  return new Secret(await vault.decrypt(stored.ciphertext, { workspaceId, provider }));
}

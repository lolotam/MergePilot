import { decodeSubscription, isSubscriptionProvider, Secret, SubscriptionRefreshError, type SubscriptionProvider } from '@mergepilot/engine';
import type { AppStore, KeyProvider, StoredCredential, Vault } from '../core/types.js';

/** A stored credential that cannot be used, with no vault or provider error text. */
export class UnavailableCredentialError extends Error {
  constructor(readonly reason: 'missing' | 'undecodable') {
    super('Subscription credential could not be resolved; sign in again');
    this.name = 'UnavailableCredentialError';
  }
}

/**
 * Why a subscription primary cannot be used in this run, when the cause will not clear by retrying:
 * a refused refresh or a missing or unreadable stored credential. Its first call then fails as an
 * auth failure, so the configured fallbacks run. The message is rebuilt from the reason, so text an
 * upstream layer appended to the error (possibly a token) never reaches the run or the review.
 */
export function terminalSubscriptionFailure(error: unknown, provider: string): { reason: string; message: string } | undefined {
  if (!isSubscriptionProvider(provider)) return undefined;
  if (error instanceof UnavailableCredentialError) return { reason: error.reason, message: new UnavailableCredentialError(error.reason).message };
  if (error instanceof SubscriptionRefreshError && !error.transient) return { reason: error.reason, message: new SubscriptionRefreshError(error.reason).message };
  return undefined;
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

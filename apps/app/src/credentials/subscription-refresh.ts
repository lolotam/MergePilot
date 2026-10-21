import { encodeSubscription, refreshSubscription, Secret, subscriptionNeedsRefresh, SubscriptionRefreshError, type SubscriptionProvider } from '@mergepilot/engine';
import type { AppStore, Vault } from '../core/types.js';
import { coordinateRefresh } from './refresh-coordination.js';
import { readStoredSubscription, UnavailableCredentialError } from './subscription-resolution.js';

/**
 * A subscription credential, refreshed and persisted under the workspace/provider lock when it is inside
 * the refresh margin (ADR-0037). A refused refresh is recorded on the row and skipped until a new sign-in.
 */
export async function resolveSubscriptionSecret(store: AppStore, vault: Vault, workspaceId: string, provider: SubscriptionProvider): Promise<Secret> {
  const initial = await store.getCredential(workspaceId, provider);
  // The provider refused the last refresh (ADR-0037): it is not asked again until a new sign-in.
  if (initial?.signInRequiredAt) throw new SubscriptionRefreshError('sign-in');
  const { value: plaintext, subscription: envelope } = await readStoredSubscription(vault, initial, workspaceId, provider);
  if (!envelope || !subscriptionNeedsRefresh(envelope.credential)) return new Secret(plaintext);
  return coordinateRefresh(store, `${workspaceId}:${provider}`, async () => {
    let value = '';
    // The refusal is remembered, not thrown inside the transaction: the flag has to commit first.
    const refusals: SubscriptionRefreshError[] = [];
    await store.modifyCredential(workspaceId, provider, async (stored) => {
      if (!stored) throw new UnavailableCredentialError('missing');
      // Another process recorded the refusal while this one waited for the lock.
      if (stored.signInRequiredAt) {
        refusals.push(new SubscriptionRefreshError('sign-in'));
        return stored;
      }
      const current = await readStoredSubscription(vault, stored, workspaceId, provider);
      value = current.value;
      const subscription = current.subscription;
      if (!subscription || !subscriptionNeedsRefresh(subscription.credential)) return stored;
      try {
        const refreshed = await refreshSubscription(provider, subscription.credential, AbortSignal.timeout(30_000));
        value = encodeSubscription(provider, refreshed);
        return { ...stored, ciphertext: await vault.encrypt(value, { workspaceId, provider }), keyVersion: vault.keyVersion, last4: refreshed.access.slice(-4), signInRequiredAt: null };
      } catch (error) {
        // Only a refused sign-in is remembered; a transient failure stays retryable.
        if (error instanceof SubscriptionRefreshError && error.reason === 'sign-in') {
          refusals.push(error);
          return { ...stored, signInRequiredAt: new Date() };
        }
        throw error;
      }
    });
    const refusal = refusals[0];
    if (refusal) throw refusal;
    return new Secret(value);
  });
}

import { isSubscriptionParentLocked } from '../credentials/key-list-helpers.js';
import { isDualMethodProvider, isKeyListProvider } from '../credentials/multi-key.js';
import {
  WorkspaceDeletedError,
  type AppStore,
  type KeyProvider,
  type StoredCredential,
  type StoredProviderKey,
  type Vault,
} from '../core/types.js';

function parentFromSlot(slot: StoredProviderKey): StoredCredential {
  return {
    id: slot.id,
    workspaceId: slot.workspaceId,
    provider: slot.provider,
    ciphertext: slot.ciphertext,
    keyVersion: slot.keyVersion,
    last4: slot.last4,
    createdBy: slot.createdBy,
    createdAt: slot.createdAt,
    baseUrl: null,
  };
}

export interface RotateResult {
  reencrypted: number;
  skipped: number;
}

async function reencryptParentIfNeeded(
  parent: StoredCredential,
  vault: Vault,
  workspaceId: string,
): Promise<StoredCredential | null> {
  if (parent.keyVersion === vault.keyVersion) return null;
  const plaintext = await vault.decrypt(parent.ciphertext, { workspaceId, provider: parent.provider });
  return {
    ...parent,
    ciphertext: await vault.encrypt(plaintext, { workspaceId, provider: parent.provider }),
    keyVersion: vault.keyVersion,
  };
}

/** Aborts a locked change without writing: returning null there would delete the provider's rows. */
class CredentialGoneError extends Error {}

type SingleOutcome = 'reencrypted' | 'skipped' | 'gone';

/**
 * Re-encrypts one credential that has no key slots. It reads and writes under the
 * workspace/provider credential lock, so a concurrent login, token refresh or disconnect
 * is never overwritten by a stale read.
 */
async function reencryptSingleCredential(
  store: AppStore,
  vault: Vault,
  workspaceId: string,
  provider: KeyProvider,
): Promise<SingleOutcome> {
  let outcome: SingleOutcome = 'skipped';
  try {
    await store.modifyCredential(workspaceId, provider, async (current) => {
      if (!current) throw new CredentialGoneError();
      const rotated = await reencryptParentIfNeeded(current, vault, workspaceId);
      outcome = rotated ? 'reencrypted' : 'skipped';
      // Returning the same object tells the Postgres store there is nothing to write.
      return rotated ?? current;
    });
  } catch (error) {
    if (error instanceof CredentialGoneError) return 'gone';
    throw error;
  }
  return outcome;
}

/**
 * Re-encrypts all credentials for the specified workspaces whose keyVersion is older
 * than the current vault keyVersion.
 */
export async function reencryptAll(
  store: AppStore,
  vault: Vault,
  workspaceIds: string[],
): Promise<RotateResult> {
  let reencrypted = 0;
  let skipped = 0;

  for (const workspaceId of workspaceIds) {
    const credList = await store.listCredentials(workspaceId);
    for (const item of credList) {
      const keyList = isKeyListProvider(item.provider);
      const slotRows = keyList ? await store.listProviderKeys(workspaceId, item.provider) : [];
      const multiWithSlots = keyList && slotRows.length > 0;

      if (!multiWithSlots) {
        if (item.keyVersion === vault.keyVersion) {
          skipped++;
        } else {
          let outcome: SingleOutcome;
          try {
            outcome = await reencryptSingleCredential(store, vault, workspaceId, item.provider);
          } catch (error) {
            // The workspace was deleted mid-rotation: its credentials are gone, nothing to rewrite.
            if (error instanceof WorkspaceDeletedError) break;
            throw error;
          }
          if (outcome === 'reencrypted') reencrypted++;
          else if (outcome === 'skipped') skipped++;
        }
      }

      if (!keyList || slotRows.length === 0) continue;

      let slotReencrypted = 0;
      let slotSkipped = 0;
      try {
        await store.modifyProviderKeys(workspaceId, item.provider, async (current, parent) => {
          slotReencrypted = 0;
          slotSkipped = 0;
          const updated: StoredProviderKey[] = [];
          for (const slot of current) {
            if (slot.keyVersion === vault.keyVersion) {
              updated.push(slot);
              slotSkipped++;
              continue;
            }
            const plaintext = await vault.decrypt(slot.ciphertext, { workspaceId, provider: slot.provider });
            updated.push({
              ...slot,
              ciphertext: await vault.encrypt(plaintext, { workspaceId, provider: slot.provider }),
              keyVersion: vault.keyVersion,
            });
            slotReencrypted++;
          }
          const sorted = [...updated].sort((a, b) => a.position - b.position);
          const first = sorted[0];
          let parentNext: StoredCredential | null | undefined = parent;
          if (parent && isDualMethodProvider(item.provider) && await isSubscriptionParentLocked(vault, parent)) {
            const rotated = await reencryptParentIfNeeded(parent, vault, workspaceId);
            parentNext = rotated ?? parent;
          } else if (first) {
            parentNext = parentFromSlot(first);
          } else if (!parent) {
            parentNext = undefined;
          }
          return { keys: sorted, parent: parentNext };
        });
      } catch (error) {
        if (error instanceof WorkspaceDeletedError) break;
        throw error;
      }
      reencrypted += slotReencrypted;
      skipped += slotSkipped;
    }
  }

  return { reencrypted, skipped };
}

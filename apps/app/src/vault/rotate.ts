import { isMultiKeyProvider } from '../credentials/multi-key.js';
import { WorkspaceDeletedError, type AppStore, type StoredProviderKey, type Vault } from '../core/types.js';

export interface RotateResult {
  reencrypted: number;
  skipped: number;
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
      if (item.keyVersion === vault.keyVersion) {
        skipped++;
      } else {
        const full = await store.getCredential(workspaceId, item.provider);
        if (full && full.keyVersion !== vault.keyVersion) {
          const plaintext = await vault.decrypt(full.ciphertext, {
            workspaceId,
            provider: full.provider,
          });
          const newCiphertext = await vault.encrypt(plaintext, {
            workspaceId,
            provider: full.provider,
          });
          try {
            await store.saveCredential({
              ...full,
              ciphertext: newCiphertext,
              keyVersion: vault.keyVersion,
            });
          } catch (error) {
            // The workspace was deleted mid-rotation: its credentials are gone, nothing to rewrite.
            if (error instanceof WorkspaceDeletedError) break;
            throw error;
          }
          reencrypted++;
        } else if (full) {
          skipped++;
        }
      }

      if (!isMultiKeyProvider(item.provider)) continue;
      const slots = await store.listProviderKeys(workspaceId, item.provider);
      const stale = slots.filter((slot) => slot.keyVersion !== vault.keyVersion);
      if (stale.length === 0) continue;
      const updated: StoredProviderKey[] = [];
      for (const slot of slots) {
        if (slot.keyVersion === vault.keyVersion) {
          updated.push(slot);
          continue;
        }
        const plaintext = await vault.decrypt(slot.ciphertext, { workspaceId, provider: slot.provider });
        updated.push({
          ...slot,
          ciphertext: await vault.encrypt(plaintext, { workspaceId, provider: slot.provider }),
          keyVersion: vault.keyVersion,
        });
      }
      try {
        await store.modifyProviderKeys(workspaceId, item.provider, async () => ({ keys: updated }));
      } catch (error) {
        if (error instanceof WorkspaceDeletedError) break;
        throw error;
      }
      reencrypted += stale.length;
    }
  }

  return { reencrypted, skipped };
}

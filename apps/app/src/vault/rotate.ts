import { isMultiKeyProvider } from '../credentials/multi-key.js';
import {
  WorkspaceDeletedError,
  type AppStore,
  type StoredCredential,
  type StoredProviderKey,
  type Vault,
} from '../core/types.js';

function parentFromSlot(slot: StoredProviderKey, baseUrl: string | null | undefined): StoredCredential {
  return {
    id: slot.id,
    workspaceId: slot.workspaceId,
    provider: slot.provider,
    ciphertext: slot.ciphertext,
    keyVersion: slot.keyVersion,
    last4: slot.last4,
    createdBy: slot.createdBy,
    createdAt: slot.createdAt,
    baseUrl: baseUrl ?? null,
  };
}

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
      let slotReencrypted = 0;
      try {
        await store.modifyProviderKeys(workspaceId, item.provider, async (current) => {
          const parent = await store.getCredential(workspaceId, item.provider);
          const updated: StoredProviderKey[] = [];
          for (const slot of current) {
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
            slotReencrypted++;
          }
          if (slotReencrypted === 0) return { keys: current };
          const sorted = [...updated].sort((a, b) => a.position - b.position);
          const first = sorted[0];
          return {
            keys: sorted,
            ...(first ? { parent: parentFromSlot(first, parent?.baseUrl) } : {}),
          };
        });
      } catch (error) {
        if (error instanceof WorkspaceDeletedError) break;
        throw error;
      }
      reencrypted += slotReencrypted;
    }
  }

  return { reencrypted, skipped };
}

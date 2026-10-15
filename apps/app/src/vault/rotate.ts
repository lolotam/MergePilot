import { isMultiKeyProvider } from '../credentials/multi-key.js';
import {
  WorkspaceDeletedError,
  type AppStore,
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
      const multi = isMultiKeyProvider(item.provider);
      const slotRows = multi ? await store.listProviderKeys(workspaceId, item.provider) : [];
      const multiWithSlots = multi && slotRows.length > 0;

      if (!multiWithSlots) {
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
      }

      if (!multi || slotRows.length === 0) continue;

      let slotReencrypted = 0;
      let slotSkipped = 0;
      try {
        await store.modifyProviderKeys(workspaceId, item.provider, async (current) => {
          slotReencrypted = 0;
          slotSkipped = 0;
          if (current.length === 0) {
            return { keys: [], parent: null };
          }
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
          if (!first) return { keys: [], parent: null };
          return { keys: sorted, parent: parentFromSlot(first) };
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

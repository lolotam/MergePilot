import type { AppStore, Vault } from '../core/types.js';

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
        continue;
      }

      const full = await store.getCredential(workspaceId, item.provider);
      if (!full) {
        continue;
      }

      if (full.keyVersion === vault.keyVersion) {
        skipped++;
        continue;
      }

      const plaintext = await vault.decrypt(full.ciphertext, {
        workspaceId,
        provider: full.provider,
      });

      const newCiphertext = await vault.encrypt(plaintext, {
        workspaceId,
        provider: full.provider,
      });

      await store.saveCredential({
        ...full,
        ciphertext: newCiphertext,
        keyVersion: vault.keyVersion,
      });

      reencrypted++;
    }
  }

  return { reencrypted, skipped };
}

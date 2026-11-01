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
import { WEBSCAN_IDENTITY_PURPOSE, type ScopedSecretVault } from './scoped-secrets.js';

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
  /** Provider credentials that were written with the new master key. */
  reencrypted: number;
  /** Provider credentials that were already on the current master key. */
  skipped: number;
  /** Scanner identity envelopes that were rewrapped with the new master key. */
  scannerReencrypted: number;
  /** Scanner identity envelopes that were already on the current master key. */
  scannerSkipped: number;
}

/** A scanner identity key envelope that a master-key rotation has to rewrap. */
export interface ScannerIdentityEnvelope {
  /** The site the identity key belongs to. It is the scope the AAD binds. */
  siteId: string;
  ciphertext: string;
  keyVersion: number;
}

/** The scanner envelopes a master-key rotation has to reach. */
export interface ScannerEnvelopeStore {
  listIdentityEnvelopes(): Promise<readonly ScannerIdentityEnvelope[]>;
  saveIdentityEnvelope(siteId: string, ciphertext: string, keyVersion: number): Promise<void>;
}

/**
 * The scanner side of a master-key rotation.
 *
 * It is a required argument of `reencryptAll` so a rotation can never report
 * success while a scanner identity key is still sealed with a master key that
 * is about to be retired.
 */
export interface ScannerRotation {
  store: ScannerEnvelopeStore;
  vault: ScopedSecretVault;
}

/**
 * Rewraps every scanner identity envelope onto the current master key.
 *
 * The sealed plaintext is the site identity key itself, so the key bytes and
 * every HMAC output derived from them survive the rotation unchanged. The
 * scope the AAD binds is the site id, which never changes, so a rewrapped
 * envelope opens with exactly the context it was sealed with.
 */
async function reencryptScannerEnvelopes(scanner: ScannerRotation): Promise<RotateResult> {
  let scannerReencrypted = 0;
  let scannerSkipped = 0;

  for (const envelope of await scanner.store.listIdentityEnvelopes()) {
    if (envelope.keyVersion === scanner.vault.keyVersion) {
      scannerSkipped++;
      continue;
    }
    const context = { purpose: WEBSCAN_IDENTITY_PURPOSE, scopeId: envelope.siteId };
    const plaintext = await scanner.vault.open(envelope.ciphertext, context);
    const ciphertext = await scanner.vault.seal(plaintext, context);
    await scanner.store.saveIdentityEnvelope(envelope.siteId, ciphertext, scanner.vault.keyVersion);
    scannerReencrypted++;
  }

  return { reencrypted: 0, skipped: 0, scannerReencrypted, scannerSkipped };
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
 * than the current vault keyVersion, and rewraps every scanner identity envelope.
 *
 * The scanner rotation is not optional: both vaults are built from the same
 * master key ring, so a rotation that skipped the scanner envelopes would leave
 * them sealed with a key that is about to be retired. The two vaults must
 * therefore agree on the key version, and the scanner envelopes are rewrapped
 * in the same call before the caller may retire the old master key.
 */
export async function reencryptAll(
  store: AppStore,
  vault: Vault,
  workspaceIds: string[],
  scanner: ScannerRotation,
): Promise<RotateResult> {
  if (scanner.vault.keyVersion !== vault.keyVersion) {
    throw new Error(
      `Scanner vault key version ${scanner.vault.keyVersion} does not match the credential vault key version ${vault.keyVersion}`,
    );
  }

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

  const scannerResult = await reencryptScannerEnvelopes(scanner);

  return {
    reencrypted,
    skipped,
    scannerReencrypted: scannerResult.scannerReencrypted,
    scannerSkipped: scannerResult.scannerSkipped,
  };
}

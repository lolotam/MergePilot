import type { KeyProvider, ProviderAuthMethod, ProviderKeyChange, StoredCredential, StoredProviderKey, Vault } from '../core/types.js';
import {
  credentialFromSlot,
  materializeLegacyKeySlotForRestore,
  mirroredParent,
  readableSubscriptionParent,
} from './key-list-helpers.js';

/** Sealed data from a backup file entry for one dual-method provider. */
export interface DualProviderRestorePlan {
  provider: KeyProvider;
  subscriptionParent: StoredCredential | null;
  keys: StoredProviderKey[];
  defaultMethod: ProviderAuthMethod | null;
  subscriptionParentFromFile: boolean;
  /** True when the backup JSON had a `keys` property (may be an empty array). */
  keysFieldPresent: boolean;
}

export type DualProviderRestoreChange = (
  current: StoredProviderKey[],
  parent: StoredCredential | null,
) => Promise<ProviderKeyChange>;

/** Overlay credential for validateSettings after a dual restore is applied. */
export function dualRestoreOverlayCredential(plan: DualProviderRestorePlan): StoredCredential | null {
  if (plan.subscriptionParentFromFile && plan.subscriptionParent) return plan.subscriptionParent;
  const first = plan.keys[0];
  if (!first) return null;
  return credentialFromSlot(first, null);
}

export function buildDualProviderRestoreChange(vault: Vault, plan: DualProviderRestorePlan): DualProviderRestoreChange {
  return async (current, parent) => dualProviderRestoreChange(vault, plan, current, parent);
}

/** Restore-only: file data wins; unreadable current parents are tolerated (R2). */
export async function dualProviderRestoreChange(
  vault: Vault,
  plan: DualProviderRestorePlan,
  current: StoredProviderKey[],
  parent: StoredCredential | null,
): Promise<ProviderKeyChange> {
  if (plan.subscriptionParentFromFile && plan.subscriptionParent) {
    if (plan.keysFieldPresent) {
      return { keys: plan.keys, parent: plan.subscriptionParent, authPreference: plan.defaultMethod };
    }
    const slots = await materializeLegacyKeySlotForRestore(vault, parent, current);
    return { keys: slots, parent: plan.subscriptionParent, authPreference: plan.defaultMethod };
  }
  const keys = plan.keys;
  if (await readableSubscriptionParent(vault, parent)) {
    return { keys, authPreference: plan.defaultMethod, cursor: 0 };
  }
  const parentNext = mirroredParent(keys, parent) ?? (keys[0] ? credentialFromSlot(keys[0], parent?.baseUrl) : null);
  return {
    keys,
    parent: parentNext,
    authPreference: plan.defaultMethod,
    cursor: 0,
  };
}

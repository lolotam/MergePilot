import { decodeSubscription, SUBSCRIPTION_PREFIX, type SubscriptionProvider } from '@mergepilot/engine';
import type { StoredCredential, StoredProviderKey, Vault } from '../core/types.js';
import { isDualMethodProvider } from './multi-key.js';

export class UnreadableCredentialError extends Error {
  constructor() {
    super('Stored credential could not be read');
    this.name = 'UnreadableCredentialError';
  }
}

export class SubscriptionEnvelopeInKeyListError extends Error {
  constructor() {
    super('Subscription credentials cannot be stored in the API key list');
    this.name = 'SubscriptionEnvelopeInKeyListError';
  }
}

export function assertPlaintextNotSubscriptionEnvelope(
  plaintext: string,
  provider: string,
): void {
  if (!plaintext.startsWith(SUBSCRIPTION_PREFIX)) return;
  if (decodeSubscription(plaintext, provider as SubscriptionProvider)) {
    throw new SubscriptionEnvelopeInKeyListError();
  }
}

export function slotFromCredential(credential: StoredCredential, position: number, id?: string): StoredProviderKey {
  return {
    id: id ?? credential.id,
    workspaceId: credential.workspaceId,
    provider: credential.provider,
    position,
    ciphertext: credential.ciphertext,
    keyVersion: credential.keyVersion,
    last4: credential.last4,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
    lastTestStatus: null,
    lastTestedAt: null,
  };
}

export function credentialFromSlot(slot: StoredProviderKey, baseUrl: string | null | undefined): StoredCredential {
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

export async function parentPlaintext(
  vault: Vault,
  parent: StoredCredential,
): Promise<string> {
  return vault.decrypt(parent.ciphertext, { workspaceId: parent.workspaceId, provider: parent.provider });
}

/** Display paths only: returns false when the parent cannot be decrypted. */
export async function isSubscriptionParent(
  vault: Vault,
  parent: StoredCredential | null,
): Promise<boolean> {
  if (!parent || !isDualMethodProvider(parent.provider)) return false;
  try {
    const value = await parentPlaintext(vault, parent);
    return Boolean(decodeSubscription(value, parent.provider as SubscriptionProvider));
  } catch {
    return false;
  }
}

/**
 * Inside `modifyProviderKeys`: throws when the parent exists but cannot be decrypted.
 * Returns false when there is no parent or the parent is not a subscription envelope.
 */
export async function isSubscriptionParentLocked(
  vault: Vault,
  parent: StoredCredential | null,
): Promise<boolean> {
  if (!parent || !isDualMethodProvider(parent.provider)) return false;
  try {
    const value = await parentPlaintext(vault, parent);
    return Boolean(decodeSubscription(value, parent.provider as SubscriptionProvider));
  } catch {
    throw new UnreadableCredentialError();
  }
}

/** Dual provider: API-key parent with no slots becomes slot 0 before append or subscription connect. */
export async function materializeLegacyKeySlot(
  vault: Vault,
  parent: StoredCredential | null,
  slots: readonly StoredProviderKey[],
): Promise<StoredProviderKey[]> {
  if (!parent || slots.length > 0) return [...slots];
  if (await isSubscriptionParentLocked(vault, parent)) return [...slots];
  return [slotFromCredential(parent, 0, parent.id)];
}

export function mirroredParent(
  keys: readonly StoredProviderKey[],
  parent: StoredCredential | null,
): StoredCredential | undefined {
  const first = keys[0];
  if (!first) return undefined;
  return credentialFromSlot(first, parent?.baseUrl);
}

/** Restore only: true when the parent decrypts to a subscription envelope. */
export async function readableSubscriptionParent(
  vault: Vault,
  parent: StoredCredential | null,
): Promise<boolean> {
  if (!parent || !isDualMethodProvider(parent.provider)) return false;
  try {
    const value = await parentPlaintext(vault, parent);
    return Boolean(decodeSubscription(value, parent.provider as SubscriptionProvider));
  } catch {
    return false;
  }
}

/** Restore only: legacy API-key parent becomes slot 0 when readable; unreadable parents are ignored. */
export async function materializeLegacyKeySlotForRestore(
  vault: Vault,
  parent: StoredCredential | null,
  slots: readonly StoredProviderKey[],
): Promise<StoredProviderKey[]> {
  if (slots.length > 0) return [...slots];
  if (!parent) return [];
  if (await readableSubscriptionParent(vault, parent)) return [];
  try {
    await parentPlaintext(vault, parent);
  } catch {
    return [];
  }
  return [slotFromCredential(parent, 0, parent.id)];
}

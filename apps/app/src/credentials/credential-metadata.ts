import type { KeyQuotaStatus, ProviderAuthMethod, StoredCredential, StoredProviderKey } from '../core/types.js';

export interface ProviderKeyPublic {
  id: string;
  position: number;
  last4: string;
  createdAt: Date;
  lastTestStatus: KeyQuotaStatus | null;
  lastTestedAt: Date | null;
}

export type KeyMetadata = Omit<StoredCredential, 'ciphertext'> & {
  authMethod?: 'api-key' | 'subscription' | 'unknown';
  keys?: ProviderKeyPublic[] | undefined;
  hasSubscription?: boolean | undefined;
  defaultMethod?: ProviderAuthMethod | undefined;
};

export function publicCredential(credential: StoredCredential, slots?: readonly StoredProviderKey[]): KeyMetadata {
  const { ciphertext: _ciphertext, ...metadata } = credential;
  return slots && slots.length > 0 ? { ...metadata, keys: slots.map(publicSlot) } : metadata;
}

export function publicSlot(slot: StoredProviderKey): ProviderKeyPublic {
  return {
    id: slot.id,
    position: slot.position,
    last4: slot.last4,
    createdAt: slot.createdAt,
    lastTestStatus: slot.lastTestStatus,
    lastTestedAt: slot.lastTestedAt,
  };
}

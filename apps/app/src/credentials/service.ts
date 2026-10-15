import { randomUUID } from 'node:crypto';
import { Secret, decodeSubscription, encodeSubscription, isSubscriptionProvider, refreshSubscription, SUBSCRIPTION_PREFIX,
  type SubscriptionCredential, type SubscriptionProvider } from '@mergepilot/engine';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import type { KeyProvider, KeyQuotaStatus, AppStore, StoredCredential, StoredProviderKey, Vault } from '../core/types.js';
import { isMultiKeyProvider, MAX_PROVIDER_KEYS } from './multi-key.js';
import { coordinateRefresh } from './refresh-coordination.js';

export class TooManyKeysError extends Error {
  readonly limit = MAX_PROVIDER_KEYS;
  constructor() {
    super(`This provider accepts at most ${MAX_PROVIDER_KEYS} API keys`);
    this.name = 'TooManyKeysError';
  }
}

export class SingleKeyProviderError extends Error {
  constructor(provider: string) {
    super(`Provider "${provider}" stores one credential`);
    this.name = 'SingleKeyProviderError';
  }
}

export class KeyOrderError extends Error {
  constructor() {
    super('Key order must list every stored key exactly once');
    this.name = 'KeyOrderError';
  }
}

class MissingProviderKeyError extends Error {
  constructor() {
    super('Stored API key was not found');
    this.name = 'MissingProviderKeyError';
  }
}

export interface ProviderKeyPublic {
  id: string;
  position: number;
  last4: string;
  createdAt: Date;
  lastTestStatus: KeyQuotaStatus | null;
  lastTestedAt: Date | null;
}

export type ValidateApiKeyFn = (provider: KeyProvider, apiKey: string, baseUrl?: string) => Promise<boolean | void>;

export interface CredentialServiceOptions {
  store: AppStore;
  vault: Vault;
  validate?: ValidateApiKeyFn | undefined;
  /** Test seam: DNS lookup for the custom base URL SSRF check. */
  ssrfLookup?: DnsLookupFn | undefined;
}

export interface SaveKeyParams {
  workspaceId: string;
  provider: KeyProvider;
  apiKey: string;
  userId: string;
  baseUrl?: string | null | undefined;
}

export type KeyMetadata = Omit<StoredCredential, 'ciphertext'> & {
  authMethod?: 'api-key' | 'subscription' | 'unknown';
  /** Present for gemini, openrouter and opencode-zen when slot rows exist. Never a secret. */
  keys?: ProviderKeyPublic[] | undefined;
};

export class CredentialService {
  readonly #store: AppStore;
  readonly #vault: Vault;
  readonly #validate: ValidateApiKeyFn | undefined;
  readonly #ssrfLookup: DnsLookupFn | undefined;

  constructor(options: CredentialServiceOptions) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#validate = options.validate;
    this.#ssrfLookup = options.ssrfLookup;
  }

  async saveKey(params: SaveKeyParams): Promise<KeyMetadata> {
    const credential = await this.sealKey(params, { validate: true });
    if (isMultiKeyProvider(params.provider)) {
      const slot = slotFrom(credential, 0, credential.id);
      await this.#store.modifyProviderKeys(params.workspaceId, params.provider, async () => ({
        keys: [slot],
        parent: credential,
        cursor: 0,
      }));
      return publicCredential(credential, [slot]);
    }
    await this.#store.saveCredential(credential);
    return publicCredential(credential);
  }

  /** Replaces the ordered list. Seals every key before the first write. */
  async saveKeyList(params: Omit<SaveKeyParams, 'apiKey'> & { apiKeys: readonly string[] }): Promise<KeyMetadata> {
    if (!isMultiKeyProvider(params.provider)) throw new SingleKeyProviderError(params.provider);
    if (params.apiKeys.length < 1 || params.apiKeys.length > MAX_PROVIDER_KEYS) throw new TooManyKeysError();
    const sealed = [];
    for (const apiKey of params.apiKeys) {
      sealed.push(await this.sealKey({ ...params, apiKey }, { validate: true }));
    }
    const first = sealed[0];
    if (!first) throw new TooManyKeysError();
    const slots = sealed.map((credential, position) => slotFrom(credential, position, credential.id));
    await this.#store.modifyProviderKeys(params.workspaceId, params.provider, async () => ({
      keys: slots,
      parent: first,
      cursor: 0,
    }));
    return publicCredential(first, slots);
  }

  /** Appends one key. A list that is already full is refused inside the lock, before any write. */
  async appendProviderKey(params: SaveKeyParams): Promise<ProviderKeyPublic> {
    if (!isMultiKeyProvider(params.provider)) throw new SingleKeyProviderError(params.provider);
    const sealed = await this.sealKey(params, { validate: true });
    const slots = await this.#store.modifyProviderKeys(params.workspaceId, params.provider, async (current) => {
      if (current.length >= MAX_PROVIDER_KEYS) throw new TooManyKeysError();
      const slot = slotFrom(sealed, current.length, sealed.id);
      if (current.length === 0) return { keys: [slot], parent: sealed, cursor: 0 };
      return { keys: [...current, slot] };
    });
    const added = slots[slots.length - 1];
    if (!added) throw new TooManyKeysError();
    return publicSlot(added);
  }

  /** Removes one key and compacts positions. False when the id is absent (nothing is written). */
  async deleteProviderKey(workspaceId: string, provider: KeyProvider, keyId: string): Promise<boolean> {
    if (!isMultiKeyProvider(provider)) throw new SingleKeyProviderError(provider);
    const parent = await this.#store.getCredential(workspaceId, provider);
    try {
      await this.#store.modifyProviderKeys(workspaceId, provider, async (current) => {
        if (!current.some((slot) => slot.id === keyId)) throw new MissingProviderKeyError();
        const remaining = current
          .filter((slot) => slot.id !== keyId)
          .map((slot, position) => ({ ...slot, position }));
        const nextParent = remaining[0];
        if (!nextParent) return { keys: [], parent: null };
        return { keys: remaining, parent: credentialFromSlot(nextParent, parent?.baseUrl), cursor: 0 };
      });
      return true;
    } catch (error) {
      if (error instanceof MissingProviderKeyError) return false;
      throw error;
    }
  }

  /** Full reorder. The id set must match the stored ids exactly, or nothing is written. */
  async reorderProviderKeys(workspaceId: string, provider: KeyProvider, ids: readonly string[]): Promise<ProviderKeyPublic[]> {
    if (!isMultiKeyProvider(provider)) throw new SingleKeyProviderError(provider);
    const parent = await this.#store.getCredential(workspaceId, provider);
    const slots = await this.#store.modifyProviderKeys(workspaceId, provider, async (current) => {
      const unique = new Set(ids);
      const known = new Set(current.map((slot) => slot.id));
      const same = ids.length === current.length && unique.size === ids.length && [...unique].every((id) => known.has(id));
      if (!same) throw new KeyOrderError();
      const byId = new Map(current.map((slot) => [slot.id, slot]));
      const keys = ids.map((id, position) => {
        const slot = byId.get(id);
        if (!slot) throw new KeyOrderError();
        return { ...slot, position };
      });
      const first = keys[0];
      if (!first) throw new KeyOrderError();
      return { keys, parent: credentialFromSlot(first, parent?.baseUrl), cursor: 0 };
    });
    return slots.map(publicSlot);
  }

  /**
   * Ordered secrets for a multi-key provider, or null when it is not one or has no credential.
   * Slot rows win; a parent with no slots is a one-key roster starting at 0.
   */
  async resolveKeyRoster(
    workspaceId: string,
    provider: KeyProvider,
  ): Promise<{ secrets: Secret[]; startIndex: number } | null> {
    if (!isMultiKeyProvider(provider)) return null;
    const parent = await this.#store.getCredential(workspaceId, provider);
    if (!parent) return null;
    const slots = await this.#store.listProviderKeys(workspaceId, provider);
    if (slots.length === 0) {
      const plaintext = await this.#vault.decrypt(parent.ciphertext, { workspaceId, provider });
      return { secrets: [new Secret(plaintext)], startIndex: 0 };
    }
    const secrets: Secret[] = [];
    for (const slot of [...slots].sort((a, b) => a.position - b.position)) {
      secrets.push(new Secret(await this.#vault.decrypt(slot.ciphertext, { workspaceId, provider })));
    }
    const cursor = await this.#store.getKeyCursor(workspaceId, provider);
    return { secrets, startIndex: cursor >= 0 && cursor < secrets.length ? cursor : 0 };
  }

  /** Persists the last successful 0-based index. The store clamps it. */
  async rememberSuccessfulKey(workspaceId: string, provider: KeyProvider, position: number): Promise<void> {
    if (!isMultiKeyProvider(provider)) return;
    await this.#store.setKeyCursor(workspaceId, provider, position);
  }

  /** Decrypts one stored slot. Null when the id is not in this workspace's list. */
  async readStoredKey(workspaceId: string, provider: KeyProvider, keyId: string): Promise<Secret | null> {
    const slot = (await this.#store.listProviderKeys(workspaceId, provider)).find((row) => row.id === keyId);
    if (!slot) return null;
    return new Secret(await this.#vault.decrypt(slot.ciphertext, { workspaceId, provider }));
  }

  async recordKeyTest(workspaceId: string, provider: KeyProvider, keyId: string, status: KeyQuotaStatus, testedAt: Date): Promise<boolean> {
    return this.#store.recordProviderKeyTest(workspaceId, provider, keyId, status, testedAt);
  }

  /** Decrypted roster in order, for a passphrase-sealed backup. Empty when there is no credential. */
  async revealRoster(workspaceId: string, provider: KeyProvider): Promise<Array<{ secret: Secret; last4: string }>> {
    const roster = await this.resolveKeyRoster(workspaceId, provider);
    if (!roster) return [];
    const slots = [...(await this.#store.listProviderKeys(workspaceId, provider))].sort((a, b) => a.position - b.position);
    if (slots.length === 0) {
      const parent = await this.#store.getCredential(workspaceId, provider);
      return roster.secrets.map((secret) => ({ secret, last4: parent?.last4 ?? '' }));
    }
    return slots.map((slot, index) => {
      const secret = roster.secrets[index];
      if (!secret) throw new Error(`Stored key at position ${slot.position} could not be read`);
      return { secret, last4: slot.last4 };
    });
  }

  /**
   * Checks and vault-encrypts a key exactly like `saveKey`, without storing it. A settings restore
   * (ADR-0018) stores the result in its own transaction and passes `validate: false`: restored keys
   * are not re-tested against the provider.
   */
  async sealKey(params: SaveKeyParams, options: { validate: boolean }): Promise<StoredCredential> {
    const trimmed = params.apiKey.trim();
    if (trimmed.length === 0) {
      throw new Error('API key cannot be empty');
    }

    // Backup restores may contain our encrypted-export OAuth envelope. The API-key path cannot import it.
    if (trimmed.startsWith(SUBSCRIPTION_PREFIX)) {
      if (options.validate) throw new Error('Use subscription sign-in instead of the API key field');
      const subscription = decodeSubscription(trimmed, params.provider)!;
      if (params.baseUrl) throw new Error('Subscription credentials cannot use a custom base URL');
      return this.sealSubscription(params.workspaceId, subscription.provider, subscription.credential, params.userId);
    }

    if (trimmed.startsWith('sk-ant-oat')) {
      throw new Error(
        'Claude subscription tokens cannot be saved as an API key. Use the Claude subscription sign-in method.',
      );
    }

    let sanitizedBaseUrl: string | null = null;
    if (params.provider === 'custom') {
      if (!params.baseUrl || !params.baseUrl.trim()) {
        throw new Error('Base URL is required for custom provider');
      }
      sanitizedBaseUrl = await assertSafeBaseUrl(params.baseUrl, this.#ssrfLookup);
    } else if (params.baseUrl?.trim()) {
      // Presets always call their fixed registry URL (ADR-0008); a stored URL would be ignored.
      throw new Error('Only the custom provider takes a base URL');
    }

    if (options.validate && this.#validate) {
      const valid = sanitizedBaseUrl
        ? await this.#validate(params.provider, trimmed, sanitizedBaseUrl)
        : await this.#validate(params.provider, trimmed);
      if (valid === false) {
        throw new Error(`API key validation failed for provider: ${params.provider}`);
      }
    }

    const ciphertext = await this.#vault.encrypt(trimmed, {
      workspaceId: params.workspaceId,
      provider: params.provider,
    });

    return {
      id: randomUUID(),
      workspaceId: params.workspaceId,
      provider: params.provider,
      ciphertext,
      keyVersion: this.#vault.keyVersion,
      last4: trimmed.slice(-4),
      createdBy: params.userId,
      createdAt: new Date(),
      baseUrl: sanitizedBaseUrl,
    };
  }

  async listKeys(workspaceId: string): Promise<KeyMetadata[]> {
    const items = await this.#store.listCredentials(workspaceId);
    const slots = await this.#store.listWorkspaceProviderKeys(workspaceId);
    return Promise.all(items.map(async (item) => {
      const keys = isMultiKeyProvider(item.provider)
        ? slots.filter((slot) => slot.provider === item.provider).sort((a, b) => a.position - b.position).map(publicSlot)
        : undefined;
      const withKeys = keys && keys.length > 0 ? { keys } : {};
      if (!isSubscriptionProvider(item.provider)) return { ...item, ...withKeys, authMethod: 'api-key' as const };
      try {
        const stored = await this.#store.getCredential(workspaceId, item.provider);
        if (!stored) return { ...item, ...withKeys, authMethod: 'unknown' as const };
        const value = await this.#vault.decrypt(stored.ciphertext, { workspaceId, provider: item.provider });
        return { ...item, ...withKeys, authMethod: decodeSubscription(value, item.provider) ? 'subscription' as const : 'api-key' as const };
      } catch {
        // Keep disconnect/replacement available even when one encrypted credential cannot be read.
        return { ...item, ...withKeys, authMethod: 'unknown' as const };
      }
    }));
  }

  async sealSubscription(workspaceId: string, provider: SubscriptionProvider, credential: SubscriptionCredential, userId: string): Promise<StoredCredential> {
    const value = encodeSubscription(provider, credential);
    return { id: randomUUID(), workspaceId, provider,
      ciphertext: await this.#vault.encrypt(value, { workspaceId, provider }),
      keyVersion: this.#vault.keyVersion, last4: credential.access.slice(-4), createdBy: userId, createdAt: new Date(), baseUrl: null };
  }

  async saveSubscription(workspaceId: string, provider: SubscriptionProvider, credential: SubscriptionCredential, userId: string, signal?: AbortSignal): Promise<void> {
    const sealed = await this.sealSubscription(workspaceId, provider, credential, userId);
    signal?.throwIfAborted();
    await this.#store.modifyCredential(workspaceId, provider, async () => {
      // Re-check after the cross-process lock is acquired, before replacing any credential.
      signal?.throwIfAborted();
      return sealed;
    }, signal);
  }

  async deleteKey(workspaceId: string, provider: KeyProvider): Promise<void> {
    await this.#store.deleteCredential(workspaceId, provider);
  }

  async resolve(workspaceId: string, provider: KeyProvider): Promise<Secret> {
    if (isSubscriptionProvider(provider)) {
      const initial = await this.#store.getCredential(workspaceId, provider);
      if (!initial) throw new Error(`No credential found for provider "${provider}" in workspace "${workspaceId}"`);
      const plaintext = await this.#vault.decrypt(initial.ciphertext, { workspaceId, provider });
      const envelope = decodeSubscription(plaintext, provider);
      if (!envelope || envelope.credential.expires > Date.now() + 60_000) return new Secret(plaintext);
      return coordinateRefresh(this.#store, `${workspaceId}:${provider}`, async () => {
        let value = '';
        await this.#store.modifyCredential(workspaceId, provider, async (stored) => {
          if (!stored) throw new Error(`No credential found for provider "${provider}" in workspace "${workspaceId}"`);
          value = await this.#vault.decrypt(stored.ciphertext, { workspaceId, provider });
          const subscription = decodeSubscription(value, provider);
          if (!subscription || subscription.credential.expires > Date.now() + 60_000) return stored;
          const refreshed = await refreshSubscription(provider, subscription.credential, AbortSignal.timeout(30_000));
          value = encodeSubscription(provider, refreshed);
          return { ...stored, ciphertext: await this.#vault.encrypt(value, { workspaceId, provider }), keyVersion: this.#vault.keyVersion, last4: refreshed.access.slice(-4) };
        });
        return new Secret(value);
      });
    }
    const cred = await this.#store.getCredential(workspaceId, provider);
    if (!cred) {
      throw new Error(`No credential found for provider "${provider}" in workspace "${workspaceId}"`);
    }

    const plaintext = await this.#vault.decrypt(cred.ciphertext, { workspaceId, provider });
    return new Secret(plaintext);
  }

  async resolveCredential(
    workspaceId: string,
    provider: KeyProvider,
  ): Promise<{ secret: Secret; baseUrl?: string | null }> {
    const cred = await this.#store.getCredential(workspaceId, provider);
    if (!cred) {
      throw new Error(`No credential found for provider "${provider}" in workspace "${workspaceId}"`);
    }

    return { secret: await this.resolve(workspaceId, provider), baseUrl: cred.baseUrl ?? null };
  }

  async getCredential(workspaceId: string, provider: KeyProvider): Promise<StoredCredential | null> {
    return this.#store.getCredential(workspaceId, provider);
  }
}

function publicCredential(credential: StoredCredential, slots?: readonly StoredProviderKey[]): KeyMetadata {
  const { ciphertext: _ciphertext, ...metadata } = credential;
  return slots && slots.length > 0 ? { ...metadata, keys: slots.map(publicSlot) } : metadata;
}

function publicSlot(slot: StoredProviderKey): ProviderKeyPublic {
  return {
    id: slot.id,
    position: slot.position,
    last4: slot.last4,
    createdAt: slot.createdAt,
    lastTestStatus: slot.lastTestStatus,
    lastTestedAt: slot.lastTestedAt,
  };
}

function slotFrom(credential: StoredCredential, position: number, id: string): StoredProviderKey {
  return {
    id,
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

function credentialFromSlot(slot: StoredProviderKey, baseUrl: string | null | undefined): StoredCredential {
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

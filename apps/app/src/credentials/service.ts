import { randomUUID } from 'node:crypto';
import { Secret, decodeSubscription, encodeSubscription, isSubscriptionOnlyProvider, isSubscriptionProvider, SUBSCRIPTION_PREFIX,
  type SubscriptionCredential, type SubscriptionProvider } from '@mergepilot/engine';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import type { KeyProvider, KeyQuotaStatus, ProviderAuthMethod, AppStore, StoredCredential, Vault } from '../core/types.js';
import {
  disconnectSubscription as disconnectDualSubscription,
  getEffectiveAuthMethod as readEffectiveAuthMethod,
  setProviderDefaultMethod as setDualDefaultMethod,
} from './credential-dual-methods.js';
import { readDualAuthState } from './dual-auth.js';
import { buildDualProviderRestoreChange, type DualProviderRestorePlan } from './dual-restore.js';
import type { RestoreProviderKeyChange } from '../core/backup-types.js';
import {
  assertPlaintextNotSubscriptionEnvelope,
  isSubscriptionParent,
  isSubscriptionParentLocked,
  materializeLegacyKeySlot,
  mirroredParent,
  slotFromCredential,
} from './key-list-helpers.js';
import { isDualMethodProvider, isKeyListProvider, MAX_PROVIDER_KEYS } from './multi-key.js';
import { readCredentialForRedaction } from './subscription-resolution.js';
import { resolveSubscriptionSecret } from './subscription-refresh.js';

export { UnavailableAuthMethodError } from './dual-auth.js';
export { NoSubscriptionConnectedError } from './credential-dual-methods.js';
export { SubscriptionEnvelopeInKeyListError, UnreadableCredentialError } from './key-list-helpers.js';

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

export type { KeyMetadata, ProviderKeyPublic } from './credential-metadata.js';
import { publicCredential, publicSlot, type KeyMetadata, type ProviderKeyPublic } from './credential-metadata.js';

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
    if (isKeyListProvider(params.provider)) {
      return this.saveKeyList({ ...params, apiKeys: [params.apiKey] });
    }
    const credential = await this.sealKey(params, { validate: true });
    await this.#store.saveCredential(credential);
    return publicCredential(credential);
  }

  /** Replaces the ordered list. Seals every key before the first write. */
  async saveKeyList(params: Omit<SaveKeyParams, 'apiKey'> & { apiKeys: readonly string[] }): Promise<KeyMetadata> {
    if (!isKeyListProvider(params.provider)) throw new SingleKeyProviderError(params.provider);
    if (params.apiKeys.length < 1 || params.apiKeys.length > MAX_PROVIDER_KEYS) throw new TooManyKeysError();
    const sealed = [];
    for (const apiKey of params.apiKeys) {
      assertPlaintextNotSubscriptionEnvelope(apiKey.trim(), params.provider);
      sealed.push(await this.sealKey({ ...params, apiKey }, { validate: true }));
    }
    const first = sealed[0];
    if (!first) throw new TooManyKeysError();
    const slots = sealed.map((credential, position) => slotFromCredential(credential, position, credential.id));
    const slotsOut = await this.#store.modifyProviderKeys(params.workspaceId, params.provider, async (_current, parent) => {
      const isSub = await isSubscriptionParentLocked(this.#vault, parent);
      const parentNext = isSub ? undefined : mirroredParent(slots, parent) ?? first;
      return { keys: slots, parent: parentNext, cursor: 0 };
    });
    const base = publicCredential(first, slotsOut);
    if (!isDualMethodProvider(params.provider)) return base;
    const dual = await readDualAuthState(this.#store, this.#vault, params.workspaceId, params.provider);
    const effective = dual?.effective;
    return { ...base, hasSubscription: dual?.hasSubscription ?? false, defaultMethod: effective ?? undefined, authMethod: effective ?? ('unknown' as const) };
  }

  /** True when the stored parent is a readable subscription envelope (restore pre-checks). */
  async hasConnectedSubscription(workspaceId: string, provider: KeyProvider): Promise<boolean> {
    const dual = await readDualAuthState(this.#store, this.#vault, workspaceId, provider);
    return dual?.hasSubscription ?? false;
  }

  /** Appends one key. A list that is already full is refused inside the lock, before any write. */
  async appendProviderKey(params: SaveKeyParams): Promise<ProviderKeyPublic> {
    if (!isKeyListProvider(params.provider)) throw new SingleKeyProviderError(params.provider);
    assertPlaintextNotSubscriptionEnvelope(params.apiKey.trim(), params.provider);
    const sealed = await this.sealKey(params, { validate: true });
    const slots = await this.#store.modifyProviderKeys(params.workspaceId, params.provider, async (current, parent) => {
      let rows = await materializeLegacyKeySlot(this.#vault, parent, current);
      if (rows.length >= MAX_PROVIDER_KEYS) throw new TooManyKeysError();
      const slot = slotFromCredential(sealed, rows.length, sealed.id);
      rows = [...rows, slot];
      const isSub = await isSubscriptionParentLocked(this.#vault, parent);
      if (!isSub && rows.length === 1) return { keys: rows, parent: sealed, cursor: 0 };
      // Appending to an existing list keeps the rotation cursor (ADR-0026).
      if (!isSub) return { keys: rows, parent: mirroredParent(rows, parent) };
      return { keys: rows };
    });
    const added = slots[slots.length - 1];
    if (!added) throw new TooManyKeysError();
    return publicSlot(added);
  }

  /** Removes one key and compacts positions. False when the id is absent (nothing is written). */
  async deleteProviderKey(workspaceId: string, provider: KeyProvider, keyId: string): Promise<boolean> {
    if (!isKeyListProvider(provider)) throw new SingleKeyProviderError(provider);
    try {
      await this.#store.modifyProviderKeys(workspaceId, provider, async (current, parent) => {
        if (!current.some((slot) => slot.id === keyId)) throw new MissingProviderKeyError();
        const remaining = current
          .filter((slot) => slot.id !== keyId)
          .map((slot, position) => ({ ...slot, position }));
        const isSub = await isSubscriptionParentLocked(this.#vault, parent);
        if (remaining.length === 0) {
          if (isSub) return { keys: [], cursor: 0 };
          return { keys: [], parent: null, cursor: 0 };
        }
        if (isSub) return { keys: remaining, cursor: 0 };
        const next = mirroredParent(remaining, parent);
        if (!next) throw new MissingProviderKeyError();
        return { keys: remaining, parent: next, cursor: 0 };
      });
      return true;
    } catch (error) {
      if (error instanceof MissingProviderKeyError) return false;
      throw error;
    }
  }

  /** Full reorder. The id set must match the stored ids exactly, or nothing is written. */
  async reorderProviderKeys(workspaceId: string, provider: KeyProvider, ids: readonly string[]): Promise<ProviderKeyPublic[]> {
    if (!isKeyListProvider(provider)) throw new SingleKeyProviderError(provider);
    const slots = await this.#store.modifyProviderKeys(workspaceId, provider, async (current, parent) => {
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
      if (keys.length === 0) throw new KeyOrderError();
      const isSub = await isSubscriptionParentLocked(this.#vault, parent);
      if (isSub) return { keys, cursor: 0 };
      const next = mirroredParent(keys, parent);
      if (!next) throw new KeyOrderError();
      return { keys, parent: next, cursor: 0 };
    });
    return slots.map(publicSlot);
  }

  /**
   * Ordered API-key secrets for a key-list provider, or null when there is no API key roster.
   * Never returns a subscription envelope (ADR-0027).
   */
  async resolveKeyRoster(
    workspaceId: string,
    provider: KeyProvider,
  ): Promise<{ secrets: Secret[]; keyIds: string[]; startIndex: number } | null> {
    if (!isKeyListProvider(provider)) return null;
    const parent = await this.#store.getCredential(workspaceId, provider);
    if (!parent) return null;
    const slots = [...(await this.#store.listProviderKeys(workspaceId, provider))].sort((a, b) => a.position - b.position);
    const isSub = await isSubscriptionParent(this.#vault, parent);
    if (isSub && slots.length === 0) return null;
    if (slots.length === 0) {
      const plaintext = await this.#vault.decrypt(parent.ciphertext, { workspaceId, provider });
      if (decodeSubscription(plaintext, provider as SubscriptionProvider)) return null;
      return { secrets: [new Secret(plaintext)], keyIds: [parent.id], startIndex: 0 };
    }
    const secrets: Secret[] = [];
    const keyIds: string[] = [];
    for (const slot of slots) {
      keyIds.push(slot.id);
      secrets.push(new Secret(await this.#vault.decrypt(slot.ciphertext, { workspaceId, provider })));
    }
    const cursor = await this.#store.getKeyCursor(workspaceId, provider);
    return { secrets, keyIds, startIndex: cursor >= 0 && cursor < secrets.length ? cursor : 0 };
  }

  /** Persists the cursor at the current position of this key id. No-op when the id is gone. */
  async rememberSuccessfulKey(workspaceId: string, provider: KeyProvider, keyId: string): Promise<void> {
    if (!isKeyListProvider(provider)) return;
    await this.#store.setKeyCursor(workspaceId, provider, keyId);
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
    if (!isKeyListProvider(provider)) return [];
    const parent = await this.#store.getCredential(workspaceId, provider);
    if (!parent) return [];
    const slots = [...(await this.#store.listProviderKeys(workspaceId, provider))].sort((a, b) => a.position - b.position);
    const isSub = await isSubscriptionParent(this.#vault, parent);
    if (isSub && slots.length === 0) return [];
    if (slots.length === 0) {
      const plaintext = await this.#vault.decrypt(parent.ciphertext, { workspaceId, provider });
      if (decodeSubscription(plaintext, provider as SubscriptionProvider)) return [];
      return [{ secret: new Secret(plaintext), last4: parent.last4 }];
    }
    const revealed: Array<{ secret: Secret; last4: string }> = [];
    for (const slot of slots) {
      revealed.push({
        secret: new Secret(await this.#vault.decrypt(slot.ciphertext, { workspaceId, provider })),
        last4: slot.last4,
      });
    }
    return revealed;
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

    if (isSubscriptionOnlyProvider(params.provider)) {
      throw new Error('This provider has no API keys. Use its subscription sign-in.');
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
      const listSlots = isKeyListProvider(item.provider)
        ? slots.filter((slot) => slot.provider === item.provider).sort((a, b) => a.position - b.position).map(publicSlot)
        : undefined;
      const withKeys = listSlots && listSlots.length > 0 ? { keys: listSlots } : {};
      if (isDualMethodProvider(item.provider)) {
        const dual = await readDualAuthState(this.#store, this.#vault, workspaceId, item.provider);
        const effective = dual?.effective;
        return {
          ...item,
          ...withKeys,
          hasSubscription: dual?.hasSubscription ?? false,
          defaultMethod: effective ?? undefined,
          authMethod: effective ?? ('unknown' as const),
        };
      }
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

  /** ADR-0027 §3 effective default for dual-method providers; null for others or when nothing is connected. */
  async getEffectiveAuthMethod(workspaceId: string, provider: KeyProvider): Promise<ProviderAuthMethod | null> {
    return readEffectiveAuthMethod(this.#store, this.#vault, workspaceId, provider);
  }

  async getDualAuthState(workspaceId: string, provider: KeyProvider) {
    return readDualAuthState(this.#store, this.#vault, workspaceId, provider);
  }

  async setProviderDefaultMethod(workspaceId: string, provider: KeyProvider, method: ProviderAuthMethod): Promise<void> {
    return setDualDefaultMethod(this.#store, this.#vault, workspaceId, provider, method);
  }

  async disconnectSubscription(workspaceId: string, provider: SubscriptionProvider): Promise<void> {
    return disconnectDualSubscription(this.#store, this.#vault, workspaceId, provider);
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
    if (isDualMethodProvider(provider)) {
      await this.#store.modifyProviderKeys(workspaceId, provider, async (current, parent) => {
        signal?.throwIfAborted();
        const keys = await materializeLegacyKeySlot(this.#vault, parent, current);
        return { keys, parent: sealed };
      }, signal);
      return;
    }
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
    if (isSubscriptionProvider(provider)) return resolveSubscriptionSecret(this.#store, this.#vault, workspaceId, provider);
    const cred = await this.#store.getCredential(workspaceId, provider);
    if (!cred) {
      throw new Error(`No credential found for provider "${provider}" in workspace "${workspaceId}"`);
    }

    const plaintext = await this.#vault.decrypt(cred.ciphertext, { workspaceId, provider });
    return new Secret(plaintext);
  }

  /** Reads even an expired envelope for redaction only; never refreshes or validates it. */
  resolveForRedaction(workspaceId: string, provider: KeyProvider): Promise<Secret | null> {
    return readCredentialForRedaction(this.#store, this.#vault, workspaceId, provider);
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

  buildDualProviderRestoreChange(plan: DualProviderRestorePlan): RestoreProviderKeyChange {
    return buildDualProviderRestoreChange(this.#vault, plan);
  }

}

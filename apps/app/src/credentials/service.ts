import { randomUUID } from 'node:crypto';
import { Secret } from '@mergepilot/engine';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import type { KeyProvider, AppStore, StoredCredential, Vault } from '../core/types.js';

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

export type KeyMetadata = Omit<StoredCredential, 'ciphertext'>;

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
    await this.#store.saveCredential(credential);

    const { ciphertext: _c, ...metadata } = credential;
    return metadata;
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

    if (trimmed.startsWith('sk-ant-oat')) {
      throw new Error(
        'Claude subscription tokens (sk-ant-oat...) are not supported in the SaaS. An Anthropic API key is required.',
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
    return items.map((item) => ({ ...item }));
  }

  async deleteKey(workspaceId: string, provider: KeyProvider): Promise<void> {
    await this.#store.deleteCredential(workspaceId, provider);
  }

  async resolve(workspaceId: string, provider: KeyProvider): Promise<Secret> {
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

    const plaintext = await this.#vault.decrypt(cred.ciphertext, { workspaceId, provider });
    return { secret: new Secret(plaintext), baseUrl: cred.baseUrl ?? null };
  }

  async getCredential(workspaceId: string, provider: KeyProvider): Promise<StoredCredential | null> {
    return this.#store.getCredential(workspaceId, provider);
  }
}

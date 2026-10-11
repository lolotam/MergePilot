import {
  MissingCredentialError,
  Secret,
  type CredentialInfo,
  type CredentialProvider,
  type CredentialRef,
  type CredentialStore,
  type RequestPurpose,
} from '@mergepilot/engine';
import type { AppStore, Vault } from '../core/types.js';

const PROVIDER_ENV_MAP: Record<CredentialProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

export interface WorkspaceCredentialStoreOptions {
  workspaceId: string;
  store: AppStore;
  vault: Vault;
}

/**
 * Implements CredentialStore for a single workspace.
 * Resolves credentials by decrypting from Vault and reading metadata from AppStore.
 * Claude Code subscription tokens are strictly rejected as per ADR-0007.
 */
export class WorkspaceCredentialStore implements CredentialStore {
  readonly #workspaceId: string;
  readonly #store: AppStore;
  readonly #vault: Vault;

  constructor(
    workspaceIdOrOptions: string | WorkspaceCredentialStoreOptions,
    store?: AppStore,
    vault?: Vault,
  ) {
    if (typeof workspaceIdOrOptions === 'string') {
      this.#workspaceId = workspaceIdOrOptions;
      if (!store || !vault) {
        throw new Error('store and vault are required when workspaceId is passed as string');
      }
      this.#store = store;
      this.#vault = vault;
    } else {
      this.#workspaceId = workspaceIdOrOptions.workspaceId;
      this.#store = workspaceIdOrOptions.store;
      this.#vault = workspaceIdOrOptions.vault;
    }
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  async info(ref: CredentialRef): Promise<CredentialInfo> {
    const envName = PROVIDER_ENV_MAP[ref.provider] ?? '';

    if (ref.provider === 'claude-code') {
      return {
        provider: 'claude-code',
        configured: false,
        source: 'none',
        envName,
      };
    }

    const cred = await this.#store.getCredential(this.#workspaceId, ref.provider);
    const configured = cred !== null;

    return {
      provider: ref.provider,
      configured,
      source: configured ? 'env' : 'none',
      envName,
    };
  }

  async resolve(ref: CredentialRef, _purpose: RequestPurpose): Promise<Secret> {
    if (ref.provider === 'claude-code') {
      throw new Error(
        'Claude Code subscription is not available in the SaaS (ADR-0007). Please configure an API key provider.',
      );
    }

    const cred = await this.#store.getCredential(this.#workspaceId, ref.provider);
    if (!cred) {
      const envName = PROVIDER_ENV_MAP[ref.provider] ?? ref.provider;
      throw new MissingCredentialError(
        envName,
        `Missing credential for provider "${ref.provider}" in workspace "${this.#workspaceId}"`,
      );
    }

    const plaintext = await this.#vault.decrypt(cred.ciphertext, {
      workspaceId: this.#workspaceId,
      provider: ref.provider,
    });

    return new Secret(plaintext);
  }
}

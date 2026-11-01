import {
  MasterKeyRing,
  PROVIDER_ENVELOPE_PREFIX,
  VaultError,
  aadFromParts,
  openEnvelope,
  parseMasterKeyRing,
  sealEnvelope,
  type EnvelopeVaultOptions,
} from './envelope.js';
import type { KeyProvider, Vault } from '../core/types.js';

export {
  VaultError,
  type EnvelopeVaultMultiKeyOptions,
  type EnvelopeVaultOptions,
  type EnvelopeVaultSingleKeyOptions,
  type MasterKeyInput,
} from './envelope.js';

/**
 * The provider credential vault (ADR-0007).
 *
 * The public shape of this class is unchanged: a provider credential is sealed
 * with the AAD `[workspaceId, provider]`, so a credential of one workspace can
 * never be opened with the context of another one, and a credential of one
 * provider can never be opened as another provider.
 *
 * The cryptography itself lives in `envelope.ts`, which the purpose-scoped
 * secret vault of `scoped-secrets.ts` shares. Nothing here is a provider
 * concept except the context this class binds.
 */

/** Unambiguous AAD: a JSON array cannot be confused the way `a:b` joins can. */
function aadFor(context: { workspaceId: string; provider: KeyProvider }): Buffer {
  return aadFromParts([context.workspaceId, context.provider]);
}

export class EnvelopeVault implements Vault {
  readonly #ring: MasterKeyRing;

  constructor(options: EnvelopeVaultOptions) {
    this.#ring = parseMasterKeyRing(options);
  }

  get keyVersion(): number {
    return this.#ring.currentVersion;
  }

  async encrypt(
    plaintext: string,
    context: { workspaceId: string; provider: KeyProvider },
  ): Promise<string> {
    return sealEnvelope(plaintext, {
      masterKey: this.#ring.currentKey,
      aad: aadFor(context),
      keyVersion: this.#ring.currentVersion,
      prefix: PROVIDER_ENVELOPE_PREFIX,
    });
  }

  async decrypt(
    ciphertext: string,
    context: { workspaceId: string; provider: KeyProvider },
  ): Promise<string> {
    const parts = ciphertext.split('.');
    const keyVersion = parts.length === 8 ? Number.parseInt(parts[1]!, 10) : Number.NaN;
    const masterKey = Number.isNaN(keyVersion) ? undefined : this.#ring.keyFor(keyVersion);
    if (masterKey === undefined) {
      throw new VaultError('decryption failed');
    }
    return openEnvelope(ciphertext, {
      masterKey,
      aad: aadFor(context),
      prefix: PROVIDER_ENVELOPE_PREFIX,
    });
  }
}

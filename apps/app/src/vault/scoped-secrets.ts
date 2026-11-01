import {
  MasterKeyRing,
  SCOPED_ENVELOPE_PREFIX,
  VaultError,
  aadFromParts,
  openEnvelope,
  parseMasterKeyRing,
  sealEnvelope,
  type EnvelopeVaultOptions,
} from './envelope.js';

/**
 * The purpose-scoped secret vault (ADR-0052 section 6).
 *
 * The provider vault in `envelope-vault.ts` seals a credential with the AAD
 * `[workspaceId, provider]`. That API is provider-typed on purpose and stays
 * exactly as it is: a scanner secret is never a provider credential and is
 * never cast to one.
 *
 * This vault is the separate API the scanner uses. It binds a purpose and a
 * scope id into the AAD, so a sealed value can only be opened by the code that
 * knows both. The AAD has three parts where the provider AAD has two, and the
 * format prefix differs, so the two families can never be opened by each other
 * even if a context were built by mistake.
 */

/** The purpose of a website scanner identity key. */
export const WEBSCAN_IDENTITY_PURPOSE = 'webscan-identity';

/** The context a scoped secret is bound to. */
export interface ScopedSecretContext {
  /** What the secret is for, for example `webscan-identity`. */
  readonly purpose: string;
  /** Which scope the secret belongs to, for example a site id. */
  readonly scopeId: string;
}

/** Seals and opens secrets that are bound to a purpose and a scope. */
export interface ScopedSecretVault {
  /** The master key version new values are sealed with. */
  readonly keyVersion: number;
  seal(plaintext: string, context: ScopedSecretContext): Promise<string>;
  open(ciphertext: string, context: ScopedSecretContext): Promise<string>;
}

/**
 * The AAD of a scoped secret.
 *
 * The leading marker keeps the scoped AAD a different shape from the provider
 * AAD, so no context can ever satisfy both.
 */
function aadFor(context: ScopedSecretContext): Buffer {
  return aadFromParts(['scoped-secret', context.purpose, context.scopeId]);
}

function assertContext(context: ScopedSecretContext): void {
  if (typeof context?.purpose !== 'string' || context.purpose.length === 0) {
    throw new Error('A scoped secret needs a purpose');
  }
  if (typeof context?.scopeId !== 'string' || context.scopeId.length === 0) {
    throw new Error('A scoped secret needs a scope id');
  }
}

export class PurposeScopedVault implements ScopedSecretVault {
  readonly #ring: MasterKeyRing;

  constructor(options: EnvelopeVaultOptions) {
    this.#ring = parseMasterKeyRing(options);
  }

  get keyVersion(): number {
    return this.#ring.currentVersion;
  }

  async seal(plaintext: string, context: ScopedSecretContext): Promise<string> {
    assertContext(context);
    return sealEnvelope(plaintext, {
      masterKey: this.#ring.currentKey,
      aad: aadFor(context),
      keyVersion: this.#ring.currentVersion,
      prefix: SCOPED_ENVELOPE_PREFIX,
    });
  }

  async open(ciphertext: string, context: ScopedSecretContext): Promise<string> {
    assertContext(context);
    const parts = ciphertext.split('.');
    const keyVersion = parts.length === 8 ? Number.parseInt(parts[1]!, 10) : Number.NaN;
    const masterKey = Number.isNaN(keyVersion) ? undefined : this.#ring.keyFor(keyVersion);
    if (masterKey === undefined) {
      throw new VaultError('decryption failed');
    }
    return openEnvelope(ciphertext, {
      masterKey,
      aad: aadFor(context),
      prefix: SCOPED_ENVELOPE_PREFIX,
    });
  }
}

/** The context of a website scanner identity key. */
export function webscanIdentityContext(siteId: string): ScopedSecretContext {
  return { purpose: WEBSCAN_IDENTITY_PURPOSE, scopeId: siteId };
}

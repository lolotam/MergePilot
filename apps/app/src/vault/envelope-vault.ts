import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider, Vault } from '../core/types.js';

export class VaultError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'VaultError';
  }
}

export type MasterKeyInput = string | Buffer;

export interface EnvelopeVaultMultiKeyOptions {
  current: number;
  keys: Map<number, MasterKeyInput> | Record<number, MasterKeyInput>;
}

export interface EnvelopeVaultSingleKeyOptions {
  masterKey: MasterKeyInput;
  keyVersion?: number;
}

export type EnvelopeVaultOptions =
  | MasterKeyInput
  | EnvelopeVaultSingleKeyOptions
  | EnvelopeVaultMultiKeyOptions;

function parseMasterKey(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) {
      throw new Error('Master key must be exactly 32 bytes');
    }
    return raw;
  }
  if (typeof raw !== 'string') {
    throw new Error('Master key must be a base64-encoded string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('Master key cannot be blank');
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new Error('Master key must be a valid base64-encoded string');
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    throw new Error('Master key must decode to exactly 32 bytes');
  }
  const reEncodedBase64 = buf.toString('base64');
  const reEncodedBase64url = buf.toString('base64url');
  if (
    trimmed !== reEncodedBase64 &&
    trimmed !== reEncodedBase64url &&
    trimmed !== reEncodedBase64.replace(/=+$/, '')
  ) {
    throw new Error('Master key must be a valid base64-encoded string');
  }
  return buf;
}

/** Unambiguous AAD: a JSON array cannot be confused the way `a:b` joins can. */
function aadFor(context: { workspaceId: string; provider: KeyProvider }): Buffer {
  return Buffer.from(JSON.stringify([context.workspaceId, context.provider]), 'utf8');
}

export class EnvelopeVault implements Vault {
  readonly #currentVersion: number;
  readonly #keys: Map<number, Buffer>;

  constructor(options: EnvelopeVaultOptions) {
    if (typeof options === 'string' || Buffer.isBuffer(options)) {
      this.#currentVersion = 1;
      this.#keys = new Map([[1, parseMasterKey(options)]]);
      return;
    }

    if (typeof options !== 'object' || options === null) {
      throw new Error('Invalid master key options');
    }

    if ('masterKey' in options) {
      const single = options as EnvelopeVaultSingleKeyOptions;
      this.#currentVersion = single.keyVersion ?? 1;
      this.#keys = new Map([[this.#currentVersion, parseMasterKey(single.masterKey)]]);
      return;
    }

    if ('current' in options && 'keys' in options) {
      const multi = options as EnvelopeVaultMultiKeyOptions;
      if (typeof multi.current !== 'number' || Number.isNaN(multi.current)) {
        throw new Error('Invalid current key version');
      }
      this.#currentVersion = multi.current;
      this.#keys = new Map();

      if (multi.keys instanceof Map) {
        for (const [ver, key] of multi.keys.entries()) {
          this.#keys.set(ver, parseMasterKey(key));
        }
      } else if (typeof multi.keys === 'object' && multi.keys !== null) {
        for (const [kStr, key] of Object.entries(multi.keys)) {
          const ver = Number(kStr);
          if (!Number.isNaN(ver)) {
            this.#keys.set(ver, parseMasterKey(key));
          }
        }
      } else {
        throw new Error('Invalid keys map');
      }

      if (!this.#keys.has(this.#currentVersion)) {
        throw new Error(`Master key for current version ${this.#currentVersion} is missing`);
      }
      return;
    }

    throw new Error('Invalid master key configuration');
  }

  get keyVersion(): number {
    return this.#currentVersion;
  }

  async encrypt(
    plaintext: string,
    context: { workspaceId: string; provider: KeyProvider },
  ): Promise<string> {
    const masterKey = this.#keys.get(this.#currentVersion);
    if (!masterKey) {
      throw new Error(`Master key for version ${this.#currentVersion} is not configured`);
    }

    const aad = aadFor(context);

    // 1. Generate random 32-byte data key and random 12-byte IV for data encryption
    const dataKey = randomBytes(32);
    const dataIv = randomBytes(12);

    // 2. Encrypt plaintext with data key (AES-256-GCM)
    const dataCipher = createCipheriv('aes-256-gcm', dataKey, dataIv);
    dataCipher.setAAD(aad);
    const ciphertext = Buffer.concat([dataCipher.update(plaintext, 'utf8'), dataCipher.final()]);
    const dataTag = dataCipher.getAuthTag();

    // 3. Wrap data key with master key (AES-256-GCM, its own 12-byte IV)
    const wrapIv = randomBytes(12);
    const keyCipher = createCipheriv('aes-256-gcm', masterKey, wrapIv);
    keyCipher.setAAD(aad);
    const wrappedKey = Buffer.concat([keyCipher.update(dataKey), keyCipher.final()]);
    const wrapTag = keyCipher.getAuthTag();

    // 4. Output versioned string v1.<keyVersion>.<base64url parts...>
    return [
      'v1',
      this.#currentVersion.toString(),
      wrapIv.toString('base64url'),
      wrappedKey.toString('base64url'),
      wrapTag.toString('base64url'),
      dataIv.toString('base64url'),
      ciphertext.toString('base64url'),
      dataTag.toString('base64url'),
    ].join('.');
  }

  async decrypt(
    ciphertext: string,
    context: { workspaceId: string; provider: KeyProvider },
  ): Promise<string> {
    try {
      const parts = ciphertext.split('.');
      const [
        prefix,
        keyVersionStr,
        wrapIvStr,
        wrappedKeyStr,
        wrapTagStr,
        dataIvStr,
        dataCiphertextStr,
        dataTagStr,
      ] = parts;

      if (
        parts.length !== 8 ||
        prefix !== 'v1' ||
        keyVersionStr === undefined ||
        wrapIvStr === undefined ||
        wrappedKeyStr === undefined ||
        wrapTagStr === undefined ||
        dataIvStr === undefined ||
        dataCiphertextStr === undefined ||
        dataTagStr === undefined
      ) {
        throw new VaultError('decryption failed');
      }

      const keyVersion = parseInt(keyVersionStr, 10);
      if (Number.isNaN(keyVersion)) {
        throw new VaultError('decryption failed');
      }

      const masterKey = this.#keys.get(keyVersion);
      if (!masterKey) {
        throw new VaultError('decryption failed');
      }

      const wrapIv = Buffer.from(wrapIvStr, 'base64url');
      const wrappedKey = Buffer.from(wrappedKeyStr, 'base64url');
      const wrapTag = Buffer.from(wrapTagStr, 'base64url');
      const dataIv = Buffer.from(dataIvStr, 'base64url');
      const dataCiphertext = Buffer.from(dataCiphertextStr, 'base64url');
      const dataTag = Buffer.from(dataTagStr, 'base64url');

      if (
        wrapIv.length !== 12 ||
        wrappedKey.length !== 32 ||
        wrapTag.length !== 16 ||
        dataIv.length !== 12 ||
        dataTag.length !== 16 ||
        wrapIv.toString('base64url') !== wrapIvStr ||
        wrappedKey.toString('base64url') !== wrappedKeyStr ||
        wrapTag.toString('base64url') !== wrapTagStr ||
        dataIv.toString('base64url') !== dataIvStr ||
        dataCiphertext.toString('base64url') !== dataCiphertextStr ||
        dataTag.toString('base64url') !== dataTagStr
      ) {
        throw new VaultError('decryption failed');
      }

      const aad = aadFor(context);

      // Unwrap data key
      const keyDecipher = createDecipheriv('aes-256-gcm', masterKey, wrapIv);
      keyDecipher.setAAD(aad);
      keyDecipher.setAuthTag(wrapTag);
      const dataKey = Buffer.concat([keyDecipher.update(wrappedKey), keyDecipher.final()]);

      // Decrypt plaintext
      const dataDecipher = createDecipheriv('aes-256-gcm', dataKey, dataIv);
      dataDecipher.setAAD(aad);
      dataDecipher.setAuthTag(dataTag);
      const plaintext = Buffer.concat([dataDecipher.update(dataCiphertext), dataDecipher.final()]);

      return plaintext.toString('utf8');
    } catch (err) {
      if (err instanceof VaultError) {
        throw err;
      }
      throw new VaultError('decryption failed');
    }
  }
}

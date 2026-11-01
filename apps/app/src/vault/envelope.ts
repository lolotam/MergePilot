import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The shared envelope primitives (ADR-0007).
 *
 * The provider vault and the purpose-scoped secret vault both seal a value with
 * a random data key and wrap that data key with a master key. Only the AAD and
 * the format prefix differ between them, so the cryptography lives here and each
 * caller binds its own context.
 *
 * Nothing in this module knows what a provider or a site is.
 */

/** A sealed value that could not be opened. The message never carries a secret. */
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

/**
 * Parses one master key.
 *
 * The key must be exactly 32 bytes, either as a buffer or as a base64 string.
 * A string that does not re-encode to the same bytes is rejected, so a
 * truncated or padded key never silently becomes a different key.
 */
export function parseMasterKey(raw: unknown): Buffer {
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

/** The master keys a vault may use, with the version that seals new values. */
export class MasterKeyRing {
  readonly #current: number;
  readonly #keys: Map<number, Buffer>;

  constructor(current: number, keys: Map<number, Buffer>) {
    this.#current = current;
    this.#keys = keys;
  }

  /** The key version new values are sealed with. */
  get currentVersion(): number {
    return this.#current;
  }

  /** The key new values are sealed with. */
  get currentKey(): Buffer {
    const key = this.#keys.get(this.#current);
    if (key === undefined) {
      throw new Error(`Master key for version ${this.#current} is not configured`);
    }
    return key;
  }

  /** The key of one version, when the vault still holds it. */
  keyFor(version: number): Buffer | undefined {
    return this.#keys.get(version);
  }
}

/**
 * Parses the master key options of every vault.
 *
 * The options are shared so the provider vault and the scoped vault can never
 * drift apart on how a key ring is built.
 */
export function parseMasterKeyRing(options: EnvelopeVaultOptions): MasterKeyRing {
  if (typeof options === 'string' || Buffer.isBuffer(options)) {
    return new MasterKeyRing(1, new Map([[1, parseMasterKey(options)]]));
  }

  if (typeof options !== 'object' || options === null) {
    throw new Error('Invalid master key options');
  }

  if ('masterKey' in options) {
    const single = options as EnvelopeVaultSingleKeyOptions;
    const version = single.keyVersion ?? 1;
    return new MasterKeyRing(version, new Map([[version, parseMasterKey(single.masterKey)]]));
  }

  if ('current' in options && 'keys' in options) {
    const multi = options as EnvelopeVaultMultiKeyOptions;
    if (typeof multi.current !== 'number' || Number.isNaN(multi.current)) {
      throw new Error('Invalid current key version');
    }
    const keys = new Map<number, Buffer>();

    if (multi.keys instanceof Map) {
      for (const [ver, key] of multi.keys.entries()) {
        keys.set(ver, parseMasterKey(key));
      }
    } else if (typeof multi.keys === 'object' && multi.keys !== null) {
      for (const [kStr, key] of Object.entries(multi.keys)) {
        const ver = Number(kStr);
        if (!Number.isNaN(ver)) {
          keys.set(ver, parseMasterKey(key));
        }
      }
    } else {
      throw new Error('Invalid keys map');
    }

    if (!keys.has(multi.current)) {
      throw new Error(`Master key for current version ${multi.current} is missing`);
    }
    return new MasterKeyRing(multi.current, keys);
  }

  throw new Error('Invalid master key configuration');
}

/**
 * Unambiguous AAD: a JSON array cannot be confused the way `a:b` joins can.
 *
 * The parts are the caller's context, so the provider vault binds a workspace
 * and a provider, and the scoped vault binds a purpose and a scope id.
 */
export function aadFromParts(parts: readonly string[]): Buffer {
  return Buffer.from(JSON.stringify(parts), 'utf8');
}

/** The format prefix of a provider credential envelope. */
export const PROVIDER_ENVELOPE_PREFIX = 'v1';

/**
 * The format prefix of a purpose-scoped envelope.
 *
 * A different prefix keeps the two families apart: a scoped envelope can never
 * be mistaken for a provider credential, and a provider credential can never be
 * opened by the scoped vault.
 */
export const SCOPED_ENVELOPE_PREFIX = 's1';

export interface SealEnvelopeOptions {
  masterKey: Buffer;
  aad: Buffer;
  keyVersion: number;
  prefix: string;
}

/**
 * Seals a value with a fresh data key and wraps that data key with the master
 * key. The output is `prefix.keyVersion.wrapIv.wrappedKey.wrapTag.dataIv.ciphertext.dataTag`.
 */
export function sealEnvelope(plaintext: string, options: SealEnvelopeOptions): string {
  const { masterKey, aad, keyVersion, prefix } = options;

  // A random 32-byte data key encrypts the value; a random 12-byte IV per step.
  const dataKey = randomBytes(32);
  const dataIv = randomBytes(12);

  const dataCipher = createCipheriv('aes-256-gcm', dataKey, dataIv);
  dataCipher.setAAD(aad);
  const ciphertext = Buffer.concat([dataCipher.update(plaintext, 'utf8'), dataCipher.final()]);
  const dataTag = dataCipher.getAuthTag();

  // The data key is wrapped with the master key, with its own 12-byte IV.
  const wrapIv = randomBytes(12);
  const keyCipher = createCipheriv('aes-256-gcm', masterKey, wrapIv);
  keyCipher.setAAD(aad);
  const wrappedKey = Buffer.concat([keyCipher.update(dataKey), keyCipher.final()]);
  const wrapTag = keyCipher.getAuthTag();

  return [
    prefix,
    keyVersion.toString(),
    wrapIv.toString('base64url'),
    wrappedKey.toString('base64url'),
    wrapTag.toString('base64url'),
    dataIv.toString('base64url'),
    ciphertext.toString('base64url'),
    dataTag.toString('base64url'),
  ].join('.');
}

export interface OpenEnvelopeOptions {
  masterKey: Buffer;
  aad: Buffer;
  prefix: string;
}

/**
 * Opens a sealed value.
 *
 * Every failure raises the same `VaultError`: a wrong AAD, a wrong key and a
 * tampered ciphertext are indistinguishable to the caller, and the message never
 * carries any part of the sealed value.
 */
export function openEnvelope(ciphertext: string, options: OpenEnvelopeOptions): string {
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
      prefix !== options.prefix ||
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

    const keyDecipher = createDecipheriv('aes-256-gcm', options.masterKey, wrapIv);
    keyDecipher.setAAD(options.aad);
    keyDecipher.setAuthTag(wrapTag);
    const dataKey = Buffer.concat([keyDecipher.update(wrappedKey), keyDecipher.final()]);

    const dataDecipher = createDecipheriv('aes-256-gcm', dataKey, dataIv);
    dataDecipher.setAAD(options.aad);
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

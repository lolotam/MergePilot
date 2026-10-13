import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from 'node:crypto';

// Passphrase encryption of the API keys in a settings backup file (ADR-0018). Server-side only:
// the browser never sees a plaintext key, and the passphrase is never logged or stored.

/** scrypt N=2^15, r=8, p=1 needs 128 * N * r = 32 MiB; Node's default cap is exactly 32 MiB. */
const SCRYPT_OPTIONS: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const BACKUP_KEY_ALG = 'aes-256-gcm';
export const BACKUP_KEY_KDF = 'scrypt';

/** One sealed key as it sits in the file; every field is base64url. */
export interface SealedKey {
  alg: typeof BACKUP_KEY_ALG;
  kdf: typeof BACKUP_KEY_KDF;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

/**
 * The wrong passphrase, or a sealed key that was changed (the GCM tag fails). Deliberately
 * carries no detail: the route answers `bad_passphrase` and nothing more.
 */
export class BadPassphraseError extends Error {
  constructor() {
    super('bad passphrase');
    this.name = 'BadPassphraseError';
  }
}

/** The same characters typed on two keyboards can differ in Unicode form (Arabic, accents). */
function normalize(passphrase: string): string {
  return passphrase.normalize('NFC');
}

/** Derives the 32-byte AES key for one passphrase and salt (async: scrypt takes ~100 ms). */
export function deriveBackupKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(normalize(passphrase), salt, KEY_BYTES, SCRYPT_OPTIONS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** A fresh random salt for one exported file. */
export function newBackupSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * Binds a sealed key to what sits next to it in the file: moving a key to another provider, or
 * pointing the custom key at another server URL, makes the GCM tag fail.
 */
function aadFor(context: { provider: string; baseUrl: string | null }): Buffer {
  return Buffer.from(JSON.stringify(['mergepilot-settings', 1, context.provider, context.baseUrl]), 'utf8');
}

/** Encrypts one API key with the file's derived key and a random 12-byte iv. */
export function sealBackupKey(
  plaintext: string,
  key: Buffer,
  salt: Buffer,
  context: { provider: string; baseUrl: string | null },
): SealedKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(BACKUP_KEY_ALG, key, iv);
  cipher.setAAD(aadFor(context));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    alg: BACKUP_KEY_ALG,
    kdf: BACKUP_KEY_KDF,
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ct: ct.toString('base64url'),
  };
}

/** Decodes a base64url field and checks its length; anything odd is a damaged file. */
function decodeField(value: string, length?: number): Buffer {
  const buf = Buffer.from(value, 'base64url');
  if (buf.toString('base64url') !== value || (length !== undefined && buf.length !== length)) {
    throw new BadPassphraseError();
  }
  return buf;
}

/** The salt of a sealed key, checked; used to derive (and cache) the key per distinct salt. */
export function sealedKeySalt(sealed: SealedKey): Buffer {
  return decodeField(sealed.salt, SALT_BYTES);
}

/** Decrypts one sealed key. Throws BadPassphraseError for a wrong passphrase or a changed file. */
export function openBackupKey(sealed: SealedKey, key: Buffer, context: { provider: string; baseUrl: string | null }): string {
  try {
    const iv = decodeField(sealed.iv, IV_BYTES);
    const tag = decodeField(sealed.tag, TAG_BYTES);
    const ct = decodeField(sealed.ct);
    const decipher = createDecipheriv(BACKUP_KEY_ALG, key, iv);
    decipher.setAAD(aadFor(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new BadPassphraseError();
  }
}

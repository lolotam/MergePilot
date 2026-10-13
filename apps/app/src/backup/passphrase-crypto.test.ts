import { describe, expect, it } from 'vitest';
import {
  BadPassphraseError,
  deriveBackupKey,
  newBackupSalt,
  openBackupKey,
  sealBackupKey,
  sealedKeySalt,
} from './passphrase-crypto.js';

/** Obvious fakes built at runtime: no secret-looking literal sits in the tests. */
const fakeKey = ['fake', 'backup', 'key', '0123456789'].join('-');
const passphrase = ['correct', 'horse', 'battery'].join(' ');
const ctx = { provider: 'anthropic', baseUrl: null };

describe('backup passphrase crypto (ADR-0018)', { timeout: 20000 }, () => {
  it('seals with scrypt + AES-256-GCM and opens with the same passphrase', async () => {
    const salt = newBackupSalt();
    const key = await deriveBackupKey(passphrase, salt);
    const sealed = sealBackupKey(fakeKey, key, salt, ctx);
    expect(sealed).toMatchObject({ alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64url') });
    expect(Buffer.from(sealed.iv, 'base64url')).toHaveLength(12);
    expect(JSON.stringify(sealed)).not.toContain(fakeKey);

    const again = await deriveBackupKey(passphrase, sealedKeySalt(sealed));
    expect(openBackupKey(sealed, again, ctx)).toBe(fakeKey);
    // A fresh iv per key: sealing twice never repeats the ciphertext.
    expect(sealBackupKey(fakeKey, key, salt, ctx).ct).not.toBe(sealed.ct);
  });

  it('treats the same passphrase in another Unicode form as equal', async () => {
    const salt = newBackupSalt();
    const composed = 'كلمة-سر-é-طويلة';
    const sealed = sealBackupKey(fakeKey, await deriveBackupKey(composed, salt), salt, ctx);
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(openBackupKey(sealed, await deriveBackupKey(decomposed, salt), ctx)).toBe(fakeKey);
  });

  it('fails with BadPassphraseError for a wrong passphrase, a changed field or a moved key', async () => {
    const salt = newBackupSalt();
    const key = await deriveBackupKey(passphrase, salt);
    const sealed = sealBackupKey(fakeKey, key, salt, ctx);
    const wrong = await deriveBackupKey(`${passphrase}!`, salt);
    expect(() => openBackupKey(sealed, wrong, ctx)).toThrow(BadPassphraseError);

    const flipped = Buffer.from(sealed.ct, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => openBackupKey({ ...sealed, ct: flipped.toString('base64url') }, key, ctx)).toThrow(BadPassphraseError);
    expect(() => openBackupKey({ ...sealed, iv: 'short' }, key, ctx)).toThrow(BadPassphraseError);
    expect(() => openBackupKey({ ...sealed, tag: `${sealed.tag}=` }, key, ctx)).toThrow(BadPassphraseError);
    expect(() => sealedKeySalt({ ...sealed, salt: 'AAAA' })).toThrow(BadPassphraseError);
    // Bound to its provider and base URL: moved or re-pointed keys do not open.
    expect(() => openBackupKey(sealed, key, { ...ctx, provider: 'openai' })).toThrow(BadPassphraseError);
    expect(() => openBackupKey(sealed, key, { ...ctx, baseUrl: 'https://evil.example' })).toThrow(BadPassphraseError);
  });

  it('never puts the passphrase or the key in the error', async () => {
    const salt = newBackupSalt();
    const sealed = sealBackupKey(fakeKey, await deriveBackupKey(passphrase, salt), salt, ctx);
    try {
      openBackupKey(sealed, await deriveBackupKey('another passphrase', salt), ctx);
      expect.unreachable();
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack ?? ''}`;
      expect(text).not.toContain(passphrase);
      expect(text).not.toContain(fakeKey);
    }
  });
});

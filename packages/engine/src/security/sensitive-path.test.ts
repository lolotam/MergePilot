import { describe, expect, it } from 'vitest';
import { isSensitivePath } from './sensitive-path.js';

describe('isSensitivePath', () => {
  it('flags .env at root and nested paths', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('nested/.env')).toBe(true);
    expect(isSensitivePath('a/b/c/.env')).toBe(true);
    expect(isSensitivePath('a\\b\\c\\.env')).toBe(true);
  });

  it('flags .env.* variants at any depth', () => {
    expect(isSensitivePath('.env.local')).toBe(true);
    expect(isSensitivePath('.env.production')).toBe(true);
    expect(isSensitivePath('config/.env.local')).toBe(true);
    expect(isSensitivePath('deep/dir/config/.env.test')).toBe(true);
    expect(isSensitivePath('config\\.env.local')).toBe(true);
  });

  it('does NOT flag .env.example at any depth', () => {
    expect(isSensitivePath('.env.example')).toBe(false);
    expect(isSensitivePath('config/.env.example')).toBe(false);
    expect(isSensitivePath('deep/dir/.env.example')).toBe(false);
    expect(isSensitivePath('config\\.env.example')).toBe(false);
  });

  it('flags *.pem and *.key files', () => {
    expect(isSensitivePath('server.pem')).toBe(true);
    expect(isSensitivePath('certs/bundle.pem')).toBe(true);
    expect(isSensitivePath('private.key')).toBe(true);
    expect(isSensitivePath('ssl/domain.key')).toBe(true);
  });

  it('flags id_rsa and id_ed25519 files', () => {
    expect(isSensitivePath('id_rsa')).toBe(true);
    expect(isSensitivePath('.ssh/id_rsa')).toBe(true);
    expect(isSensitivePath('id_rsa.pub')).toBe(true);
    expect(isSensitivePath('id_rsa_backup')).toBe(true);
    expect(isSensitivePath('id_ed25519')).toBe(true);
    expect(isSensitivePath('.ssh/id_ed25519')).toBe(true);
    expect(isSensitivePath('.ssh/id_ed25519.pub')).toBe(true);
  });

  it('flags *.p12 and *.pfx files', () => {
    expect(isSensitivePath('cert.p12')).toBe(true);
    expect(isSensitivePath('certs/cert.p12')).toBe(true);
    expect(isSensitivePath('keystore.pfx')).toBe(true);
    expect(isSensitivePath('nested/keystore.pfx')).toBe(true);
  });

  it('flags credentials.json, .npmrc, and .pypirc files', () => {
    expect(isSensitivePath('credentials.json')).toBe(true);
    expect(isSensitivePath('config/credentials.json')).toBe(true);
    expect(isSensitivePath('.npmrc')).toBe(true);
    expect(isSensitivePath('home/.npmrc')).toBe(true);
    expect(isSensitivePath('.pypirc')).toBe(true);
    expect(isSensitivePath('home/.pypirc')).toBe(true);
  });

  it('does NOT flag non-sensitive files', () => {
    expect(isSensitivePath('')).toBe(false);
    expect(isSensitivePath('.')).toBe(false);
    expect(isSensitivePath('/')).toBe(false);
    expect(isSensitivePath('src/index.ts')).toBe(false);
    expect(isSensitivePath('package.json')).toBe(false);
    expect(isSensitivePath('README.md')).toBe(false);
    expect(isSensitivePath('src/dotenv.ts')).toBe(false);
    expect(isSensitivePath('environment.ts')).toBe(false);
    expect(isSensitivePath('key.ts')).toBe(false);
    expect(isSensitivePath('token.json')).toBe(false);
  });
});

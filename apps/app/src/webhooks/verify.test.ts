import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature } from './verify.js';

describe('verifyGitHubSignature', () => {
  const secret = 'super-webhook-secret';
  const body = Buffer.from('{"hello":"world"}', 'utf8');

  function sign(buf: Buffer, s: string): string {
    return `sha256=${createHmac('sha256', s).update(buf).digest('hex')}`;
  }

  it('accepts a valid signature matching raw bytes', () => {
    const validHeader = sign(body, secret);
    expect(verifyGitHubSignature(body, validHeader, secret)).toBe(true);
  });

  it('is sensitive to exact whitespace in raw body', () => {
    const formattedBody = Buffer.from('{\n  "hello": "world"\n}', 'utf8');
    const signatureForCompact = sign(body, secret);
    expect(verifyGitHubSignature(formattedBody, signatureForCompact, secret)).toBe(false);
  });

  it('rejects tampered raw body bytes', () => {
    const validHeader = sign(body, secret);
    const tampered = Buffer.from('{"hello":"warld"}', 'utf8');
    expect(verifyGitHubSignature(tampered, validHeader, secret)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const validHeader = sign(body, 'wrong-secret');
    expect(verifyGitHubSignature(body, validHeader, secret)).toBe(false);
  });

  it('returns false on missing or undefined header', () => {
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGitHubSignature(body, '', secret)).toBe(false);
  });

  it('returns false on malformed header without sha256= prefix', () => {
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGitHubSignature(body, hex, secret)).toBe(false);
    expect(verifyGitHubSignature(body, `sha1=${hex}`, secret)).toBe(false);
    expect(verifyGitHubSignature(body, 'sha256=', secret)).toBe(false);
  });

  it('returns false when signature lengths do not match without throwing', () => {
    expect(verifyGitHubSignature(body, 'sha256=short', secret)).toBe(false);
    expect(verifyGitHubSignature(body, `sha256=${'a'.repeat(128)}`, secret)).toBe(false);
  });

  it('returns false on empty or invalid secret', () => {
    const validHeader = sign(body, secret);
    expect(verifyGitHubSignature(body, validHeader, '')).toBe(false);
  });

  it('handles empty buffer payload with valid signature', () => {
    const empty = Buffer.from('', 'utf8');
    const header = sign(empty, secret);
    expect(verifyGitHubSignature(empty, header, secret)).toBe(true);
  });
});

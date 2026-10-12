import { describe, expect, it } from 'vitest';
import { assertSafeBaseUrl, isPrivateIp, SsrFValidationError } from './ssrf.js';

describe('isPrivateIp', () => {
  it('identifies loopback addresses', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.1.2.3')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('0:0:0:0:0:0:0:1')).toBe(true);
  });

  it('identifies private IPv4 ranges (RFC 1918)', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('192.168.0.1')).toBe(true);
    expect(isPrivateIp('192.168.255.255')).toBe(true);
  });

  it('identifies link-local and cloud metadata addresses', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('identifies IPv6 unique local (fc00::/7)', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456:789a::1')).toBe(true);
  });

  it('identifies IPv4-mapped IPv6 addresses', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:10.1.2.3')).toBe(true);
    expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv4 and IPv6 addresses', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('142.250.190.46')).toBe(false);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertSafeBaseUrl', () => {
  it('rejects non-https URLs', async () => {
    await expect(assertSafeBaseUrl('http://api.openai.com/v1')).rejects.toThrow(SsrFValidationError);
    await expect(assertSafeBaseUrl('ftp://api.openai.com/v1')).rejects.toThrow('HTTPS only');
    await expect(assertSafeBaseUrl('file:///etc/passwd')).rejects.toThrow('HTTPS only');
  });

  it('rejects loopback hostname and IPs', async () => {
    await expect(assertSafeBaseUrl('https://127.0.0.1:8080')).rejects.toThrow('private or loopback');
    await expect(assertSafeBaseUrl('https://localhost:8080')).rejects.toThrow('private or loopback');
    await expect(assertSafeBaseUrl('https://[::1]:8080')).rejects.toThrow('private or loopback');
  });

  it('rejects private IPv4 addresses', async () => {
    await expect(assertSafeBaseUrl('https://10.0.0.5/v1')).rejects.toThrow('private or loopback');
    await expect(assertSafeBaseUrl('https://192.168.1.1/v1')).rejects.toThrow('private or loopback');
    await expect(assertSafeBaseUrl('https://172.20.0.1/v1')).rejects.toThrow('private or loopback');
  });

  it('rejects link-local / cloud metadata IP 169.254.169.254', async () => {
    await expect(assertSafeBaseUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      'private or loopback',
    );
  });

  it('rejects domains that resolve to private or loopback IPs', async () => {
    const mockLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(assertSafeBaseUrl('https://evil.local/v1', mockLookup)).rejects.toThrow(
      'private or loopback',
    );
  });

  it('accepts safe public HTTPS URLs and trims trailing slashes', async () => {
    const mockLookup = async () => [{ address: '104.18.2.1', family: 4 }];
    const sanitized = await assertSafeBaseUrl('https://api.custom-model.com/v1///', mockLookup);
    expect(sanitized).toBe('https://api.custom-model.com/v1');
  });
});

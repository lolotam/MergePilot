import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from './secret.js';

describe('Secret', () => {
  it('wraps a value in a private field and reveals it via reveal()', () => {
    const secret = new Secret('sk-test-000');
    expect(secret.reveal()).toBe('sk-test-000');
  });

  it('never exposes the value in toString()', () => {
    const secret = new Secret('sk-test-000');
    expect(secret.toString()).toBe('[REDACTED]');
    expect(String(secret)).toBe('[REDACTED]');
  });

  it('never exposes the value in template literals', () => {
    const secret = new Secret('sk-test-000');
    expect(`Bearer ${secret}`).toBe('Bearer [REDACTED]');
  });

  it('never exposes the value in toJSON() or JSON.stringify()', () => {
    const secret = new Secret('sk-test-000');
    expect(secret.toJSON()).toBe('[REDACTED]');
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[REDACTED]"}');
  });

  it('never exposes the value in util.inspect', () => {
    const secret = new Secret('sk-test-000');
    expect(util.inspect(secret)).toBe('[REDACTED]');
    const inspectedObj = util.inspect({ auth: secret });
    expect(inspectedObj).toContain('[REDACTED]');
    expect(inspectedObj).not.toContain('sk-test-000');
  });
});

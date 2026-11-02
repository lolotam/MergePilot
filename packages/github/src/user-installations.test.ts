import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { listUserInstallations } from './user-installations.js';

describe('user installation transport failures', () => {
  const token = ['gh', 'u', '_', 'private-test-token'].join('');
  const original = Object.assign(new Error(`Request failed with ${token}`), {
    authorization: token,
    cause: new Error(`Nested failure with ${token}`),
  });

  it.each([
    { label: 'error with stack, fields and nested cause', thrown: original },
    { label: 'frozen error', thrown: Object.freeze(new Error(token)) },
    { label: 'plain object', thrown: { authorization: token } },
    { label: 'string', thrown: token },
    { label: 'hostile conversion', thrown: { toString() { throw new Error(token); } } },
  ])('never retains a credential from a $label', async ({ thrown }) => {
    const fetchFn: typeof fetch = async () => { throw thrown; };
    const failure: unknown = await listUserInstallations(token, fetchFn).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected a transport error');
    expect(failure.message).toBe('Failed to fetch user installations');
    expect(failure.cause).toBeUndefined();
    expect(inspect(failure, { depth: null })).not.toContain(token);
    expect(JSON.stringify(failure)).not.toContain(token);
    // The caller's thrown value is never mutated while constructing the safe error.
    expect(original.message).toContain(token);
  });
});

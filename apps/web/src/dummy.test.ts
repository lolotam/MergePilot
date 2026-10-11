import { describe, it, expect } from 'vitest';
import { authClient } from './auth/client.js';

describe('auth client setup', () => {
  it('initializes authClient with signIn and organization plugin', () => {
    expect(authClient).toBeDefined();
    expect(typeof authClient.signIn.social).toBe('function');
    expect(authClient.organization).toBeDefined();
    expect(typeof authClient.organization.create).toBe('function');
  });
});

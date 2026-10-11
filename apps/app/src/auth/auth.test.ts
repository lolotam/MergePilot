import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createAuth } from './auth.js';
import * as schema from './schema.js';
import type { AppConfig } from '../core/config.js';

describe('auth configuration', () => {
  const fakeConfig: AppConfig = {
    baseUrl: 'https://mergepilot.walidmohamed.com',
    port: 3000,
    databaseUrl: 'postgres://localhost:5432/test',
    redisUrl: 'redis://localhost:6379',
    masterKey: '01234567890123456789012345678901',
    github: {
      appId: '12345',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
      webhookSecret: 'whsec_test',
      clientId: 'gh-client-id-test',
      clientSecret: 'gh-client-secret-test',
    },
    google: {
      clientId: 'google-client-id-test',
      clientSecret: 'google-client-secret-test',
    },
    authSecret: 'sk-test-secret-32-chars-long-0000000',
  };

  it('wires both providers, account linking, secure cookies, and organization roles', () => {
    const pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    const auth = createAuth({ db, config: fakeConfig });

    // Assert on the built options object
    expect(auth.options.baseURL).toBe(fakeConfig.baseUrl);
    expect(auth.options.secret).toBe(fakeConfig.authSecret);
    expect(auth.options.trustedOrigins).toEqual([fakeConfig.baseUrl]);

    // GitHub social provider
    const github = auth.options.socialProviders?.github;
    expect(github).toBeDefined();
    expect(github?.clientId).toBe(fakeConfig.github.clientId);
    expect(github?.clientSecret).toBe(fakeConfig.github.clientSecret);
    expect(github?.scope).toEqual(expect.arrayContaining(['read:user', 'user:email']));

    // Google social provider
    const google = auth.options.socialProviders?.google;
    expect(google).toBeDefined();
    expect(google?.clientId).toBe(fakeConfig.google.clientId);
    expect(google?.clientSecret).toBe(fakeConfig.google.clientSecret);
    expect(google?.scope).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));

    // Account linking enabled for trusted providers
    expect(auth.options.account?.accountLinking?.enabled).toBe(true);
    expect(auth.options.account?.accountLinking?.trustedProviders).toEqual(
      expect.arrayContaining(['google', 'github']),
    );

    // Email and password disabled
    expect(auth.options.emailAndPassword?.enabled).toBe(false);

    // Secure cookies
    expect(auth.options.advanced?.useSecureCookies).toBe(true);

    // Organization plugin
    const orgPlugin = auth.options.plugins?.find((p) => p.id === 'organization');
    expect(orgPlugin).toBeDefined();
    expect(orgPlugin?.options?.creatorRole).toBe('owner');
    expect(orgPlugin?.options?.invitationExpiresIn).toBe(7 * 24 * 60 * 60);

    const roles = Object.keys(orgPlugin?.options?.roles ?? {});
    expect(roles.sort()).toEqual(['admin', 'member', 'owner'].sort());
  });
});

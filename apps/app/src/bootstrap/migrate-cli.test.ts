import { describe, expect, it, vi } from 'vitest';
import { runMigrateCli } from './migrate-cli.js';

describe('bootstrap/migrate-cli', () => {
  it('runs migrations against test db or memory db without error', async () => {
    const fakeEnv: Record<string, string> = {
      MERGEPILOT_BASE_URL: 'https://test.mergepilot.com',
      PORT: '3000',
      DATABASE_URL: 'memory:',
      REDIS_URL: 'memory:',
      MERGEPILOT_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
      GITHUB_WEBHOOK_SECRET: 'fake-webhook-secret',
      GITHUB_CLIENT_ID: 'fake-gh-client-id',
      GITHUB_CLIENT_SECRET: 'fake-gh-client-secret',
      GOOGLE_CLIENT_ID: 'fake-google-id',
      GOOGLE_CLIENT_SECRET: 'fake-google-secret',
      BETTER_AUTH_SECRET: 'better-auth-secret-1234567890',
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runMigrateCli(fakeEnv);
      expect(Array.isArray(result)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

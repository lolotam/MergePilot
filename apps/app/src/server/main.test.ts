import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import { createMainServer } from './main.js';

describe('server/main', { timeout: 20000 }, () => {
  const webhookSecret = 'test-webhook-secret-12345';
  const masterKey = randomBytes(32).toString('base64');
  let testDistDir: string;

  const fakeEnv: Record<string, string> = {
    MERGEPILOT_BASE_URL: 'https://test.mergepilot.com',
    DATABASE_URL: 'memory:',
    REDIS_URL: 'memory:',
    MERGEPILOT_MASTER_KEY: masterKey,
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-sec',
    GOOGLE_CLIENT_ID: 'goog-id',
    GOOGLE_CLIENT_SECRET: 'goog-sec',
    BETTER_AUTH_SECRET: 'auth-sec-12345678901234567890',
    PORT: '4000',
  };

  beforeEach(async () => {
    testDistDir = await mkdtemp(join(tmpdir(), 'mergepilot-server-main-'));
    await writeFile(
      join(testDistDir, 'index.html'),
      '<!doctype html><html><body><div id="root">SPA Root</div></body></html>',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(testDistDir, { recursive: true, force: true });
  });

  function sign(payload: string): string {
    return `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`;
  }

  it('initializes with MemoryStore and in-memory queue when URLs are memory:', async () => {
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
    });
    try {
      expect(serverInstance.store).toBeInstanceOf(MemoryStore);
      expect(serverInstance.config.port).toBe(4000);

      const res = await serverInstance.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    } finally {
      await serverInstance.stop();
    }
  });

  it('includes Helmet security headers with CSP configured', async () => {
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
    });
    try {
      const res = await serverInstance.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain('avatars.githubusercontent.com');
      expect(csp).toContain('googleusercontent.com');
      // No inline scripts allowed
      expect(csp).not.toContain("'unsafe-inline'; script-src");
    } finally {
      await serverInstance.stop();
    }
  });

  it('enforces rate limit on /api/auth/* at 30/min', async () => {
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
    });
    try {
      // 30 requests to /api/auth should succeed or return non-429
      for (let i = 0; i < 30; i++) {
        const res = await serverInstance.app.inject({
          method: 'GET',
          url: '/api/auth/get-session',
        });
        expect(res.statusCode).not.toBe(429);
      }

      // 31st request should be rate-limited (429)
      const limitedRes = await serverInstance.app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
      });
      expect(limitedRes.statusCode).toBe(429);
    } finally {
      await serverInstance.stop();
    }
  });

  it('does NOT rate-limit webhook route even after 35 calls', async () => {
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
    });
    try {
      const payload = JSON.stringify({ action: 'opened' });
      const signature = sign(payload);

      for (let i = 0; i < 35; i++) {
        const res = await serverInstance.app.inject({
          method: 'POST',
          url: '/webhooks/github',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'unknown_event',
            'x-github-delivery': `delivery-${i}`,
            'x-hub-signature-256': signature,
          },
          payload,
        });
        expect(res.statusCode).not.toBe(429);
      }
    } finally {
      await serverInstance.stop();
    }
  });

  it('allows registering fake API module via options/plugin', async () => {
    const apiRegistered = vi.fn();
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
      dashboardApiRegistrar: async (instance) => {
        apiRegistered();
        instance.get('/api/custom-endpoint', async () => ({ custom: true }));
      },
    });
    try {
      expect(apiRegistered).toHaveBeenCalled();
      const res = await serverInstance.app.inject({
        method: 'GET',
        url: '/api/custom-endpoint',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ custom: true });
    } finally {
      await serverInstance.stop();
    }
  });

  it('SPA fallback serves index.html for /w/x/settings but returns 404 for /api/*', async () => {
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
    });
    try {
      // /w/x/settings should fall back to index.html
      const spaRes = await serverInstance.app.inject({
        method: 'GET',
        url: '/w/x/settings',
      });
      expect(spaRes.statusCode).toBe(200);
      expect(spaRes.body).toContain('SPA Root');
      expect(spaRes.headers['cache-control']).toBe('no-cache');

      // /api/* missing route should return 404, not index.html
      const apiRes = await serverInstance.app.inject({
        method: 'GET',
        url: '/api/nonexistent-route',
      });
      expect(apiRes.statusCode).toBe(404);
      expect(apiRes.body).not.toContain('SPA Root');
    } finally {
      await serverInstance.stop();
    }
  });

  it('GET /ready returns 503 when Redis is down (fake probe)', async () => {
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
      probes: {
        store: async () => true,
        queue: async () => false, // Redis is down
      },
    });
    try {
      const res = await serverInstance.app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).ok).toBe(false);
    } finally {
      await serverInstance.stop();
    }
  });

  it('graceful shutdown closes server and services', async () => {
    const serverInstance = await createMainServer({
      env: fakeEnv,
      distDir: testDistDir,
    });
    await expect(serverInstance.stop()).resolves.toBeUndefined();
  });
});

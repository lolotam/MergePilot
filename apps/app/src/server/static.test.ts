import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerStatic } from './static.js';

describe('server/static', () => {
  let app: FastifyInstance;
  let testDistDir: string;

  beforeEach(async () => {
    app = fastify({ logger: false });
    testDistDir = await mkdtemp(join(tmpdir(), 'mergepilot-web-dist-'));
  });

  afterEach(async () => {
    await app.close();
    await rm(testDistDir, { recursive: true, force: true });
  });

  describe('when dist directory exists with assets and index.html', () => {
    beforeEach(async () => {
      // Create mock index.html
      await writeFile(
        join(testDistDir, 'index.html'),
        '<!doctype html><html><body><div id="root">App Root</div></body></html>',
        'utf8',
      );

      // Create mock assets directory and a hashed asset
      const assetsDir = join(testDistDir, 'assets');
      await mkdir(assetsDir, { recursive: true });
      await writeFile(
        join(assetsDir, 'index-Bf6h1234.js'),
        'console.log("main bundle");',
        'utf8',
      );
    });

    it('serves static hashed asset with long cache headers', async () => {
      await registerStatic(app, { distDir: testDistDir });

      const res = await app.inject({
        method: 'GET',
        url: '/assets/index-Bf6h1234.js',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('main bundle');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('serves index.html with no-cache header on root GET /', async () => {
      await registerStatic(app, { distDir: testDistDir });

      const res = await app.inject({
        method: 'GET',
        url: '/',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('App Root');
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('SPA fallback serves index.html for /w/x/settings with no-cache', async () => {
      await registerStatic(app, { distDir: testDistDir });

      const res = await app.inject({
        method: 'GET',
        url: '/w/x/settings',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('App Root');
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('does NOT serve SPA fallback for /api/* routes (returns 404)', async () => {
      await registerStatic(app, { distDir: testDistDir });

      const res = await app.inject({
        method: 'GET',
        url: '/api/workspaces/unknown',
      });

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('App Root');
    });

    it('does NOT serve SPA fallback for /webhooks/* routes (returns 404)', async () => {
      await registerStatic(app, { distDir: testDistDir });

      const res = await app.inject({
        method: 'GET',
        url: '/webhooks/unknown',
      });

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('App Root');
    });
  });

  describe('when dist directory is missing', () => {
    it('serves a placeholder HTML page for /w/x/settings', async () => {
      const nonExistentDir = join(testDistDir, 'does-not-exist');
      await registerStatic(app, { distDir: nonExistentDir });

      const res = await app.inject({
        method: 'GET',
        url: '/w/x/settings',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('MergePilot');
    });

    it('returns 404 for /api/* routes even when dist is missing', async () => {
      const nonExistentDir = join(testDistDir, 'does-not-exist');
      await registerStatic(app, { distDir: nonExistentDir });

      const res = await app.inject({
        method: 'GET',
        url: '/api/something',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

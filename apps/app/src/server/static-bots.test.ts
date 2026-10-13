import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOT_LOGOS } from '../core/types.js';
import { registerStatic } from './static.js';

// The reviewer-panel logos (ADR-0017) are linked from GitHub comments, so they must be served
// publicly, without a session. Vite copies `apps/web/public` into the dashboard build as is.
const publicDir = fileURLToPath(new URL('../../../web/public', import.meta.url));

describe('bot logos', () => {
  const app = fastify({ logger: false });
  beforeAll(async () => {
    await registerStatic(app, { distDir: publicDir });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(BOT_LOGOS)('serves /bots/%s.svg with status 200 and no auth', async (key) => {
    const res = await app.inject({ method: 'GET', url: `/bots/${key}.svg` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.body.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">')).toBe(true);
  });

  it('keeps every logo small and self-contained (no scripts or external references)', async () => {
    for (const key of BOT_LOGOS) {
      const svg = await readFile(`${publicDir}/bots/${key}.svg`, 'utf8');
      expect(Buffer.byteLength(svg)).toBeLessThan(1024);
      expect(svg).not.toMatch(/<script|href=|url\(/i);
    }
  });
});

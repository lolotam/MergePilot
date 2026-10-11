import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface StaticOptions {
  distDir?: string | undefined;
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MergePilot</title>
</head>
<body>
  <main style="font-family: sans-serif; padding: 2rem; text-align: center;">
    <h1>MergePilot</h1>
    <p>Web dashboard is building...</p>
  </main>
</body>
</html>`;

export function resolveDefaultDistDir(): string {
  const cwdDir = join(process.cwd(), 'apps', 'web', 'dist');
  if (existsSync(cwdDir)) {
    return cwdDir;
  }
  const metaDir = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  if (existsSync(metaDir)) {
    return metaDir;
  }
  return cwdDir;
}

export async function registerStatic(
  app: FastifyInstance,
  options?: StaticOptions,
): Promise<void> {
  const targetDistDir = options?.distDir ?? resolveDefaultDistDir();
  const distExists = existsSync(targetDistDir);
  const indexHtmlPath = join(targetDistDir, 'index.html');
  const indexExists = distExists && existsSync(indexHtmlPath);

  if (distExists) {
    await app.register(fastifyStatic, {
      root: targetDistDir,
      prefix: '/',
      serve: true,
      wildcard: true,
      setHeaders: (reply: FastifyReply, filePath: string) => {
        if (filePath.endsWith('index.html')) {
          reply.header('cache-control', 'no-cache');
        } else if (
          /\.[a-f0-9]{8,}\./i.test(filePath) ||
          filePath.includes('/assets/') ||
          filePath.includes('\\assets\\')
        ) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const url = (request.url ?? '').split('?')[0] ?? '';
    const isGet = request.method === 'GET';
    const isApi = url.startsWith('/api') || url === '/api';
    const isWebhook = url.startsWith('/webhooks') || url === '/webhooks';

    if (isGet && !isApi && !isWebhook) {
      if (indexExists) {
        const html = await readFile(indexHtmlPath, 'utf8');
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-cache')
          .status(200)
          .send(html);
      }
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .status(200)
        .send(PLACEHOLDER_HTML);
    }

    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });
}

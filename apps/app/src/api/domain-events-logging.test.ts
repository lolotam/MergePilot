import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import * as authSchema from '../auth/schema.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import { CredentialService } from '../credentials/service.js';
import { runMigrations } from '../db/migrate.js';
import { PgStore } from '../db/pg-store.js';
import * as dbSchema from '../db/schema.js';
import { createServer } from '../server/create-server.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { registerDashboardApi } from './routes.js';

function createCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed) {
          try {
            lines.push(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            // ignore non-json
          }
        }
      }
      callback();
    },
  });
  return { stream, lines };
}

describe('Domain events logging - Core API', () => {
  const workspaceId = 'ws-domain-1';
  const userId = 'u-admin-1';
  const sessionToken = ['tok', 'adm', '1'].join('-');
  const webhookSecret = 'wh-sec';
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: PgStore;
  let credentials: CredentialService;
  let queue: ReviewQueue;
  let cookie: string;

  const mockConfig: AppConfig = {
    baseUrl: 'https://test.mergepilot.com',
    port: 3000,
    databaseUrl: 'memory:',
    redisUrl: 'redis://localhost:6379',
    masterKey: '0'.repeat(32),
    github: {
      appId: '12345',
      privateKey: 'pem',
      webhookSecret,
      clientId: 'gh-id',
      clientSecret: 'gh-sec',
      appSlug: 'mergepilot-test',
    },
    google: { clientId: 'g-id', clientSecret: 'g-sec' },
    authSecret: 'x'.repeat(32),
  };

  const fakeGithubFetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers(),
    json: async () => ({
      total_count: 1,
      installations: [
        { id: 999, account: { login: 'testorg', type: 'Organization' }, repository_selection: 'all' },
      ],
    }),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    pglite = new PGlite();
    await runMigrations(pglite);
    db = drizzle(pglite, { schema: { ...authSchema, ...dbSchema } });
    store = new PgStore(db);
    const vault = new EnvelopeVault(Buffer.alloc(32, 1).toString('base64'));
    credentials = new CredentialService({ store, vault });
    queue = {
      async enqueue(_job: ReviewJob) {},
    };

    await db.insert(authSchema.user).values([
      { id: userId, name: 'Admin', email: 'admin@test.com', emailVerified: true },
    ]);
    await db.insert(authSchema.session).values([
      { id: 'sess-1', token: sessionToken, userId, expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    await db.insert(authSchema.organization).values([
      { id: workspaceId, name: 'Domain WS', slug: 'domain-ws' },
    ]);
    await db.insert(authSchema.member).values([
      { id: 'm-1', organizationId: workspaceId, userId, role: 'owner' },
    ]);
    await db.insert(authSchema.account).values([
      {
        id: 'acc-1',
        userId,
        accountId: 'gh-user-1',
        providerId: 'github',
        accessToken: 'gh-tok',
      },
    ]);

    await store.saveSettings({
      workspaceId,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      language: 'en',
      monthlyBudgetUsd: null,
    });

    cookie = signedSessionCookie(sessionToken, mockConfig.authSecret);
  });

  afterEach(async () => {
    await pglite.close();
  });

  function setupApp(logger: import('pino').Logger) {
    const auth = createAuth({ db, config: mockConfig });
    return createServer({
      config: mockConfig,
      store,
      queue,
      log: logger,
      extraRoutes: (instance) => {
        registerAuthRoutes(instance, auth);
        registerDashboardApi(instance, {
          auth,
          store,
          credentials,
          config: mockConfig,
          queue,
          githubFetch: fakeGithubFetch as unknown as typeof fetch,
          validateKey: vi.fn().mockResolvedValue(undefined),
        });
      },
    });
  }

  function sign(payload: string): string {
    return `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`;
  }

  it('logs key saved and key deleted events with provider only (no secret)', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    const fakeKey = ['tk', 'ant', 'k'.repeat(20)].join('-');

    const resSave = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${workspaceId}/keys/anthropic`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ apiKey: fakeKey }),
    });
    expect(resSave.statusCode).toBe(200);

    const saveLog = lines.find((l) => l.event === 'credential.key_saved');
    expect(saveLog).toBeDefined();
    expect(saveLog?.provider).toBe('anthropic');
    expect(saveLog?.workspaceId).toBe(workspaceId);
    expect(JSON.stringify(saveLog)).not.toContain(fakeKey);

    const resDel = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/keys/anthropic`,
      headers: { cookie },
    });
    expect(resDel.statusCode).toBe(204);

    const delLog = lines.find((l) => l.event === 'credential.key_deleted');
    expect(delLog).toBeDefined();
    expect(delLog?.provider).toBe('anthropic');
    expect(delLog?.workspaceId).toBe(workspaceId);
  });

  it('logs settings changed event with names of changed fields only', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${workspaceId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-3-5-haiku',
        language: 'ar',
      }),
    });
    expect(res.statusCode).toBe(200);

    const settingsLog = lines.find((l) => l.event === 'settings.changed');
    expect(settingsLog).toBeDefined();
    expect(settingsLog?.workspaceId).toBe(workspaceId);
    expect(settingsLog?.changedFields).toEqual(['model', 'language']);
    expect(settingsLog?.model).toBeUndefined();
    expect(settingsLog?.language).toBeUndefined();

    // Resubmitting the same values with one real change reports only that field.
    const again = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${workspaceId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ provider: 'anthropic', model: 'claude-3-5-haiku', language: 'en' }),
    });
    expect(again.statusCode).toBe(200);
    const second = lines.filter((l) => l.event === 'settings.changed')[1];
    expect(second?.changedFields).toEqual(['language']);
  });

  it('logs workspace renamed and deleted events', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    const resRename = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'New Name' }),
    });
    expect(resRename.statusCode).toBe(200);

    const renameLog = lines.find((l) => l.event === 'workspace.renamed');
    expect(renameLog).toBeDefined();
    expect(renameLog?.workspaceId).toBe(workspaceId);

    const resDelete = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ confirmName: 'New Name' }),
    });
    expect(resDelete.statusCode).toBe(204);

    const deleteLog = lines.find((l) => l.event === 'workspace.deleted');
    expect(deleteLog).toBeDefined();
    expect(deleteLog?.workspaceId).toBe(workspaceId);
  });

  it('logs installation linked and unlinked events', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    const resLink = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/installations/999/link`,
      headers: { cookie },
    });
    expect(resLink.statusCode).toBe(204);

    const linkLog = lines.find((l) => l.event === 'installation.linked');
    expect(linkLog).toBeDefined();
    expect(linkLog?.workspaceId).toBe(workspaceId);
    expect(linkLog?.installationId).toBe(999);

    const uninstPayload = JSON.stringify({
      action: 'deleted',
      installation: { id: 999 },
    });

    const resWebhook = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-github-delivery': 'del-del-inst',
        'x-hub-signature-256': sign(uninstPayload),
      },
      payload: uninstPayload,
    });
    expect(resWebhook.statusCode).toBe(202);

    // One line per delivery: the outcome line carries the domain detail.
    const webhookLines = lines.filter((l) => l.deliveryId === 'del-del-inst');
    expect(webhookLines).toHaveLength(1);
    const unlinkLog = webhookLines[0];
    expect(unlinkLog?.msg).toBe('webhook received');
    expect(unlinkLog?.event).toBe('installation');
    expect(unlinkLog?.outcome).toBe('processed');
    expect(unlinkLog?.domainEvent).toBe('installation.unlinked');
    expect(unlinkLog?.installationId).toBe(999);
    expect(lines.filter((l) => l.event === 'installation.unlinked')).toHaveLength(0);
  });

  it('puts the signed-in userId and workspaceId on the request completion line', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    const res = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/settings`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const completion = lines.filter((l) => l.msg === 'request completed');
    expect(completion).toHaveLength(1);
    expect(completion[0]?.userId).toBe(userId);
    expect(completion[0]?.workspaceId).toBe(workspaceId);
  });

  it('puts the userId on the completion line of a signed-in non-workspace route', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);

    const completion = lines.find((l) => l.msg === 'request completed' && l.path === '/api/me');
    expect(completion?.userId).toBe(userId);
  });
});

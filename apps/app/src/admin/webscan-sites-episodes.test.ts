import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createAuth, type Auth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { webScanSites } from '../db/schema.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import type { WebScanEventBus } from '../webscan/events.js';
import type { WebScanAlertEpisode } from '../webscan/types.js';
import { WebScanSiteDtoSchema } from '../api/contract-webscan-site.js';
import { registerAdminApi } from './routes.js';
import {
  adminTestConfig,
  createAdminTestDb,
  fixtureToken,
  seedAdminFixtures,
  type AdminTestDb,
} from './admin.fixtures.js';

/**
 * The alert episodes of a site in the REST response (ADR-0052 section 8).
 *
 * The alert engine persists the state of an episode next to the fields it
 * always had: the observed state of the issue, the request of a delivery, the
 * resolution and the level the episode started at. The response has to carry
 * them, or an issue whose state could not be established reads as an open one.
 */

describe('the alert episodes of a site', () => {
  const config = adminTestConfig(['admin@mergepilot.com']);
  const adminCookie = signedSessionCookie(fixtureToken('admin'), config.authSecret);
  const masterKey = randomBytes(32).toString('base64');

  const events: WebScanEventBus = {
    publish: () => {},
    subscribe: async () => {},
    close: async () => {},
  };

  const emptyScope = {
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  };

  let app: FastifyInstance;
  let handle: AdminTestDb;
  let store: PgWebScanStore;

  beforeAll(async () => {
    handle = await createAdminTestDb();
    const auth: Auth = createAuth({ db: handle.db, config });
    app = fastify();
    registerAuthRoutes(app, auth);
    store = new PgWebScanStore(handle.db, new PurposeScopedVault({ masterKey }));
    registerAdminApi(app, {
      auth,
      db: handle.db,
      config,
      webScan: { store, events },
    });
    await seedAdminFixtures(handle.db);
    await app.ready();
  });

  beforeEach(async () => {
    // The site of the previous test is gone, so every test starts from an
    // empty site list.
    await handle.db.delete(webScanSites);
  });

  const createSite = async (hostname: string) =>
    app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: {
        hostname,
        baseUrl: `https://${hostname}`,
        scope: { ...emptyScope },
        authorize: true,
      },
    });

  const getSite = async (siteId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie },
    });

  it('an episode whose issue state is unknown keeps that state in the response', async () => {
    const created = await createSite('unknown.example.com');
    expect(created.statusCode).toBe(201);
    const siteId = created.json().id as string;

    const episode: WebScanAlertEpisode = {
      episodeKey: 'ep-unknown',
      issueKey: 'issue-1',
      state: 'open',
      occurrenceKeys: ['occ-1'],
      lastChangedAt: '2026-11-02T10:00:00.000Z',
      issueState: 'unknown',
      issueRequested: true,
      resolved: false,
      severity: 'high',
      validation: 'Likely',
      generation: 1,
      createdAt: '2026-11-02T09:00:00.000Z',
    };
    await store.setSiteAlertEpisodes('u-admin', siteId, [episode]);

    const response = await getSite(siteId);
    expect(response.statusCode).toBe(200);
    const episodes = response.json().alertEpisodes as WebScanAlertEpisode[];
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      episodeKey: 'ep-unknown',
      issueKey: 'issue-1',
      issueState: 'unknown',
      issueRequested: true,
      resolved: false,
      severity: 'high',
      validation: 'Likely',
      generation: 1,
      createdAt: '2026-11-02T09:00:00.000Z',
    });

    // The response answers the strict contract of a site.
    expect(WebScanSiteDtoSchema.safeParse(response.json()).success).toBe(true);
  });

  it('the first episode of a group (generation 0) answers the strict contract', async () => {
    const created = await createSite('first-episode.example.com');
    expect(created.statusCode).toBe(201);
    const siteId = created.json().id as string;

    // The engine starts every group at generation 0.
    const episode: WebScanAlertEpisode = {
      episodeKey: 'ep-first',
      issueKey: 'issue-first',
      state: 'open',
      occurrenceKeys: ['occ-1'],
      lastChangedAt: '2026-11-02T10:00:00.000Z',
      issueState: 'none',
      issueRequested: false,
      resolved: false,
      severity: 'high',
      validation: 'Likely',
      generation: 0,
      createdAt: '2026-11-02T09:00:00.000Z',
    };
    await store.setSiteAlertEpisodes('u-admin', siteId, [episode]);

    const response = await getSite(siteId);
    expect(response.statusCode).toBe(200);
    expect(WebScanSiteDtoSchema.safeParse(response.json()).success).toBe(true);
    expect((response.json().alertEpisodes as WebScanAlertEpisode[])[0]?.generation).toBe(0);
  });

  it('an episode without the newer fields keeps them absent', async () => {
    const created = await createSite('legacy.example.com');
    const siteId = created.json().id as string;

    const episode: WebScanAlertEpisode = {
      episodeKey: 'ep-legacy',
      issueKey: 'issue-2',
      state: 'open',
      occurrenceKeys: [],
      lastChangedAt: '2026-11-02T10:00:00.000Z',
    };
    await store.setSiteAlertEpisodes('u-admin', siteId, [episode]);

    const response = await getSite(siteId);
    const episodes = response.json().alertEpisodes as WebScanAlertEpisode[];
    expect(episodes).toHaveLength(1);
    expect(Object.keys(episodes[0] ?? {}).sort()).toEqual([
      'episodeKey',
      'issueKey',
      'lastChangedAt',
      'occurrenceKeys',
      'state',
    ]);
    expect(WebScanSiteDtoSchema.safeParse(response.json()).success).toBe(true);
  });
});

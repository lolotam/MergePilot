import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSeededAdminApp, type AdminTestDb } from './admin.fixtures.js';
import { containsPattern } from './queries.js';

describe('containsPattern', () => {
  it('wraps the term and escapes LIKE wildcards and backslashes', () => {
    expect(containsPattern('acme')).toBe('%acme%');
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

// Seed: users "Admin User" <admin@mergepilot.com> and "Regular User" <user@example.com>;
// runs: two in ws-1 "Acme Corp", one in ws-2 "Solo Project".
describe('admin API server-side search', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;
  let adminCookie: string;

  beforeEach(async () => {
    ({ app, handle, adminCookie } = await createSeededAdminApp());
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  async function get(url: string) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('GET /api/admin/users?q matches name or email, case-insensitively, with the filtered total', async () => {
    const byName = await get('/api/admin/users?q=regular');
    expect(byName.users.map((u: { id: string }) => u.id)).toEqual(['u-regular']);
    expect(byName.total).toBe(1);

    const byEmail = await get('/api/admin/users?q=MERGEPILOT.COM');
    expect(byEmail.users.map((u: { id: string }) => u.id)).toEqual(['u-admin']);
    expect(byEmail.total).toBe(1);

    const none = await get('/api/admin/users?q=nobody');
    expect(none.users).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('GET /api/admin/users treats wildcards literally and ignores a blank q', async () => {
    expect((await get('/api/admin/users?q=%25')).total).toBe(0);
    expect((await get('/api/admin/users?q=_')).total).toBe(0);
    expect((await get(`/api/admin/users?q=${encodeURIComponent("' OR 1=1 --")}`)).total).toBe(0);
    expect((await get('/api/admin/users?q=%20%20')).total).toBe(2);
  });

  it('GET /api/admin/runs?workspaceQuery filters by workspace name', async () => {
    const acme = await get('/api/admin/runs?workspaceQuery=acme');
    expect(acme.total).toBe(2);
    expect(acme.runs.every((r: { workspaceId: string }) => r.workspaceId === 'ws-1')).toBe(true);

    const solo = await get('/api/admin/runs?workspaceQuery=SOLO');
    expect(solo.total).toBe(1);
    expect(solo.runs[0].workspaceName).toBe('Solo Project');

    expect((await get('/api/admin/runs?workspaceQuery=zzz')).total).toBe(0);
  });

  it('GET /api/admin/runs combines workspaceId and workspaceQuery', async () => {
    expect((await get('/api/admin/runs?workspaceId=ws-1&workspaceQuery=acme')).total).toBe(2);
    expect((await get('/api/admin/runs?workspaceId=ws-1&workspaceQuery=solo')).total).toBe(0);
  });
});
